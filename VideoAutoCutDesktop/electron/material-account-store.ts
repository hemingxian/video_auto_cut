import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { VIDEO_EXTENSIONS } from './file-extensions.js'
import { createMaterialLocalStore, type MaterialLocalStoreOptions } from './material-local-store.js'

interface MaterialAccountScope {
  serviceUrl: string
  userId: string
}

type MaterialLocalStore = ReturnType<typeof createMaterialLocalStore>
type ScopeReader = () => MaterialAccountScope | null | undefined
const INVENTORY_MIGRATION_KEY = 'account_local_inventory_migration_v1'

/** Tokens and display names deliberately do not participate in persistent identity. */
function materialAccountScopeKey(scope: MaterialAccountScope | null | undefined): string {
  if (!scope?.userId?.trim() || !scope.serviceUrl?.trim()) return 'guest'
  const endpoint = new URL(scope.serviceUrl.trim())
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('素材服务地址无效')
  const service = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}`
  return createHash('sha256').update(JSON.stringify([service, scope.userId.trim()])).digest('hex')
}

function isWithin(directory: string, boundary: string): boolean {
  const relative = path.relative(path.resolve(boundary), path.resolve(directory))
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/**
 * Every account gets its own complete database: IDs, outbox, cursor, transfers and
 * drafts are inseparable. Physical local videos remain in the existing workspace.
 * A captured async scope stays attached to its original database after sign-out.
 * The caller must separately cancel/guard requests using that account's session.
 */
function createAccountScopedMaterialStore(options: MaterialLocalStoreOptions, readScope: ScopeReader) {
  const accountRoot = path.join(path.dirname(path.resolve(options.databasePath)), 'material-accounts')
  const context = new AsyncLocalStorage<string>()
  const stores = new Map<string, MaterialLocalStore>()
  let closed = false

  function captureScope(): string {
    return materialAccountScopeKey(readScope())
  }

  function effectiveScope(): string {
    return context.getStore() || captureScope()
  }

  function validateScope(scope: string): void {
    if (scope !== 'guest' && !/^[a-f0-9]{64}$/.test(scope)) throw new Error('素材账号范围无效')
  }

  function getScopeDatabasePath(scope = effectiveScope()): string {
    validateScope(scope)
    return path.join(accountRoot, scope, 'material-library.sqlite')
  }

  function legacySnapshot(): string | undefined {
    const legacy = path.resolve(options.databasePath)
    if (!fs.existsSync(legacy)) return undefined
    const quarantine = path.join(accountRoot, 'legacy-unscoped')
    const snapshot = path.join(quarantine, 'material-library.sqlite')
    fs.mkdirSync(quarantine, { recursive: true })
    if (!fs.existsSync(snapshot)) {
      // VACUUM INTO includes committed WAL pages, unlike copying just the main file.
      const temporary = `${snapshot}.tmp-${process.pid}-${Date.now()}`
      const source = new DatabaseSync(legacy, { readOnly: true })
      try {
        source.exec('PRAGMA busy_timeout = 5000')
        source.prepare('VACUUM INTO ?').run(temporary)
        fs.renameSync(temporary, snapshot)
      } finally {
        source.close()
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      }
    }
    const note = path.join(quarantine, 'README.json')
    if (!fs.existsSync(note)) {
      fs.writeFileSync(note, JSON.stringify({
        schema_version: 1,
        reason: 'Legacy database ownership cannot be established. Cloud IDs, sync operations, cursors and task bindings are not assigned to any account.',
        original_database: legacy,
        original_preserved: true,
        snapshot_database: snapshot,
        created_at: new Date().toISOString(),
      }, null, 2), { encoding: 'utf8', flag: 'wx' })
    }
    return snapshot
  }

  function migrateLocalInventory(store: MaterialLocalStore, accountDatabase: string): void {
    if (store.getCloudState(INVENTORY_MIGRATION_KEY)) return
    const snapshot = legacySnapshot()
    const sources = snapshot ? [snapshot] : []
    // Plain local imports are device files and may be registered by another
    // account. Only inventory is shared; each account allocates fresh identities.
    for (const entry of fs.readdirSync(accountRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || (entry.name !== 'guest' && !/^[a-f0-9]{64}$/.test(entry.name))) continue
      const candidate = getScopeDatabasePath(entry.name)
      if (candidate !== accountDatabase && fs.existsSync(candidate)) sources.push(candidate)
    }
    let imported = 0
    let skipped = 0
    const seenPaths = new Set<string>()
    const files: ReturnType<ReturnType<DatabaseSync['prepare']>['all']> = []
    for (const candidate of sources) {
      const source = new DatabaseSync(candidate, { readOnly: true })
      try {
      // Read only present local file inventory. Never reuse legacy remote IDs or
      // trust its "ready" analysis marker as evidence of an available index.
        files.push(...source.prepare(`
        SELECT DISTINCT file.relative_path, file.source_sha256, file.source_size, file.mtime
        FROM local_asset_file file
        JOIN local_material_file_map map ON map.local_file_id = file.local_file_id
        JOIN material material ON material.material_id = map.material_id
        WHERE file.local_status = 'present' AND material.deleted_at IS NULL
          AND material.added_from NOT IN ('cloud_restore', 'public_library')
        ORDER BY file.relative_path
        `).all())
      } finally {
        source.close()
      }
    }
    if (files.length) {
      const rootFolder = store.getOrCreateFolder({ scope: 'virtual', storageKey: 'materials-root', name: '素材库' })
      for (const row of files) {
        const localPath = path.resolve(options.dataRoot, String(row.relative_path || ''))
        const canonicalKey = process.platform === 'win32' ? localPath.toLowerCase() : localPath
        if (seenPaths.has(canonicalKey)) continue
        seenPaths.add(canonicalKey)
        const boundary = isWithin(localPath, options.materialsDir)
          ? options.materialsDir
          : isWithin(localPath, options.runsDir) ? options.runsDir : undefined
        if (!boundary || isWithin(localPath, path.join(options.materialsDir, 'cloud'))
          || !VIDEO_EXTENSIONS.includes(path.extname(localPath).toLowerCase())) {
          skipped++
          continue
        }
        try {
          const stat = fs.lstatSync(localPath)
          if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(fs.realpathSync(localPath), fs.realpathSync(boundary))) {
            skipped++
            continue
          }
          const scope = boundary === options.materialsDir ? 'user' : 'downloads'
          let parentFolderId = store.getOrCreateFolder(scope === 'user'
            ? { scope: 'user', storageKey: '.', name: '本地素材', parentFolderId: rootFolder }
            : { scope: 'virtual', storageKey: 'downloads-root', name: '云端素材', parentFolderId: rootFolder })
          const segments = path.relative(boundary, path.dirname(localPath)).split(path.sep).filter(Boolean)
          for (let index = 0; index < segments.length; index++) {
            parentFolderId = store.getOrCreateFolder({
              scope,
              storageKey: segments.slice(0, index + 1).join('/'),
              name: segments[index],
              parentFolderId,
            })
          }
          const unchanged = stat.size === Number(row.source_size)
            && Math.abs(stat.mtimeMs - Number(row.mtime)) < 0.5
            && /^[a-f0-9]{64}$/.test(String(row.source_sha256))
          store.registerMaterialFile(localPath, {
            folderId: parentFolderId,
            origin: scope === 'user' ? 'user_upload' : 'platform_download',
            addedFrom: scope === 'user' ? 'user_import' : 'task_download',
            ...(unchanged ? { sourceSha256: String(row.source_sha256), sourceSize: stat.size } : {}),
          })
          imported++
        } catch {
          // Unreadable/disappeared files stay in the preserved database and can be
          // rediscovered by a later ordinary directory scan. No physical deletion.
          skipped++
        }
      }
    }
    store.setCloudState(INVENTORY_MIGRATION_KEY, JSON.stringify({ imported, skipped }))
  }

  function storeForScope(scope: string): MaterialLocalStore {
    if (closed) throw new Error('素材数据库已关闭')
    validateScope(scope)
    const existing = stores.get(scope)
    if (existing) return existing
    const store = createMaterialLocalStore({ ...options, databasePath: getScopeDatabasePath(scope) })
    try {
      migrateLocalInventory(store, getScopeDatabasePath(scope))
      stores.set(scope, store)
      return store
    } catch (error) {
      store.close()
      throw error
    }
  }

  function runInScope<T>(scope: string, operation: () => T): T {
    validateScope(scope)
    if (closed) throw new Error('素材数据库已关闭')
    return context.run(scope, operation)
  }

  function close(): void {
    if (closed) return
    closed = true
    for (const store of stores.values()) store.close()
    stores.clear()
    context.disable()
  }

  const scopeMethods = { captureScope, effectiveScope, runInScope, getScopeDatabasePath, close }
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>()
  return new Proxy(scopeMethods as MaterialLocalStore & typeof scopeMethods, {
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property)
      if (property === 'then' || typeof property === 'symbol') return undefined
      if (!methods.has(property)) {
        methods.set(property, (...args: unknown[]) => {
          const scope = effectiveScope()
          const store = storeForScope(scope)
          const method = Reflect.get(store, property)
          if (typeof method !== 'function') throw new Error(`未知素材数据库操作：${String(property)}`)
          return context.run(scope, () => Reflect.apply(method, store, args))
        })
      }
      return methods.get(property)
    },
  })
}

export { createAccountScopedMaterialStore, materialAccountScopeKey, type MaterialAccountScope }
