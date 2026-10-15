import fs from 'node:fs'
import path from 'node:path'
import type { IpcMainInvokeEvent, Shell } from 'electron'

import { IPC_INVOKE } from './ipc-channels.js'
import { SCRIPT_EXTENSIONS } from './file-extensions.js'
import { asRecord } from './types.js'

type InvokeChannel = typeof IPC_INVOKE[keyof typeof IPC_INVOKE]
type IpcListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type HandleRegistrar = (channel: InvokeChannel, listener: IpcListener) => void

interface ScriptRevealRegistry {
  captureScope: () => string
  recordTaskStart: (options: unknown, result: unknown, scope?: string) => boolean
  reveal: (target: unknown) => boolean
}

interface ScriptRevealRegistryOptions {
  shell: Pick<Shell, 'showItemInFolder'>
  currentScope: () => string
  registryFile: (scope: string) => string
  historicalScripts: () => unknown[]
}

function validatedScriptPath(target: unknown): string {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error('脚本文件必须使用绝对路径')
  }
  if (!fs.existsSync(target)) throw new Error('脚本文件不存在')

  const requestedExtension = path.extname(target).toLowerCase()
  if (!SCRIPT_EXTENSIONS.includes(requestedExtension)) throw new Error('不支持的脚本文件类型')

  const canonicalPath = fs.realpathSync.native(target)
  const stat = fs.statSync(canonicalPath)
  if (!stat.isFile()) throw new Error('脚本目标不是文件')
  if (!SCRIPT_EXTENSIONS.includes(path.extname(canonicalPath).toLowerCase())) {
    throw new Error('不支持的脚本文件类型')
  }
  return canonicalPath
}

function scriptIdentity(file: string): string {
  const normalized = path.normalize(file)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function createScriptRevealRegistry(options: ScriptRevealRegistryOptions): ScriptRevealRegistry {
  const scopeCache = new Map<string, Set<string>>()

  function save(scope: string, scripts: Set<string>): void {
    const target = options.registryFile(scope)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, scope, scripts: [...scripts] }, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, target)
  }

  function scriptsForScope(scope: string): Set<string> {
    const cached = scopeCache.get(scope)
    if (cached) return cached
    const scripts = new Set<string>()
    const target = options.registryFile(scope)
    try {
      const record = asRecord(JSON.parse(fs.readFileSync(target, 'utf8')))
      if (record.schema_version === 1 && record.scope === scope && Array.isArray(record.scripts)) {
        for (const item of record.scripts) {
          try { scripts.add(scriptIdentity(validatedScriptPath(item))) } catch { /* stale entry */ }
        }
      }
    } catch { /* First use or damaged registry: rebuild only from bounded run history. */ }
    scopeCache.set(scope, scripts)
    return scripts
  }

  function recordTaskStart(taskOptions: unknown, result: unknown, scope = options.currentScope()): boolean {
    if (asRecord(result).ok !== true) return false
    const scriptPath = asRecord(taskOptions).scriptPath
    try {
      const canonicalPath = validatedScriptPath(scriptPath)
      const scripts = scriptsForScope(scope)
      scripts.add(scriptIdentity(canonicalPath))
      save(scope, scripts)
      return true
    } catch {
      return false
    }
  }

  function reveal(target: unknown): boolean {
    const canonicalPath = validatedScriptPath(target)
    const identity = scriptIdentity(canonicalPath)
    const registered = scriptsForScope(options.currentScope()).has(identity)
    let historical = false
    if (!registered) {
      try {
        historical = options.historicalScripts().some((item) => {
          try { return scriptIdentity(validatedScriptPath(item)) === identity } catch { return false }
        })
      } catch { /* History discovery failures never widen access. */ }
    }
    if (!registered && !historical) {
      throw new Error('脚本文件未登记为已启动任务')
    }
    options.shell.showItemInFolder(canonicalPath)
    return true
  }

  return { captureScope: options.currentScope, recordTaskStart, reveal }
}

function registerTaskStartHandler(
  handle: HandleRegistrar,
  start: (options: unknown) => unknown,
  scriptRevealRegistry: ScriptRevealRegistry,
): void {
  handle(IPC_INVOKE.taskStart, async (_event, options = {}) => {
    const scope = scriptRevealRegistry.captureScope()
    const result = await start(options)
    // Registration is side bookkeeping. It must never change a successfully launched task result.
    try {
      scriptRevealRegistry.recordTaskStart(options, result, scope)
    } catch {
      // A task may already be running even if the selected file can no longer be registered.
    }
    return result
  })
}

export {
  createScriptRevealRegistry,
  registerTaskStartHandler,
  validatedScriptPath,
}
export type {
  HandleRegistrar,
  ScriptRevealRegistry,
}
