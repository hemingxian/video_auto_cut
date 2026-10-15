import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { VIDEO_EXTENSIONS } from './file-extensions.js'
import { createFileEntry, createUniqueDestination } from './file-entry.js'
import type { FileEntry } from './types.js'
import { ensureDir } from './utils.js'
import { verifiedResumeMaterialShots, sameFrozenMaterial } from './resume-material-manifest.js'

type MaterialFolderScope = 'virtual' | 'user' | 'downloads'
type MaterialOrigin = 'user_upload' | 'platform_download'
type MaterialAddedFrom = 'user_import' | 'task_download' | 'cloud_restore' | 'public_library'
type MaterialPublicationStatus = 'private' | 'publishing' | 'public' | 'suspended' | 'removed'
type MaterialBindingInput =
  | { binding_type: 'material'; material_id: string }
  | { binding_type: 'folder'; folder_id: string; include_subfolders: boolean }

interface MaterialSelectionSummaryOptions {
  bindings?: unknown
}

interface MaterialSelectionSummary {
  candidateCount: number
  entries: Array<{ key: string; candidateKeys: string[] }>
}

interface MaterialFolderIdentityInput {
  scope: MaterialFolderScope
  storageKey: string
  name: string
  parentFolderId?: string
}

interface MaterialFolderIdentity {
  folderId: string
  scope: MaterialFolderScope
  storageKey: string
  name: string
  parentFolderId?: string
  revision: number
  cloudRevision: number
}

interface MaterialFileIdentity {
  materialId: string
  assetId: string
  assetVersion: number
  sourceSha256: string
  localStatus: 'present' | 'missing' | 'damaged'
  analysisStatus: 'pending' | 'analyzing' | 'ready' | 'failed'
  analysisError?: string
  cloudAnalysisStatus?: 'pending' | 'analyzing' | 'ready' | 'failed'
  cloudAnalysisError?: string
  cloudStatus: 'not_uploaded' | 'uploading' | 'verifying' | 'ready' | 'deleting' | 'failed' | 'deleted'
  cloudError?: string
  folderId: string
  localFolderId?: string
  cloudFolderId?: string
  localPath: string
}

interface MaterialCloudFile extends MaterialFileIdentity {
  displayName: string
  mimeType: string
  sourceSize: number
  origin: MaterialOrigin
  addedFrom: MaterialAddedFrom
  revision: number
  cloudRevision: number
  cloudAnalysisStatus: MaterialFileIdentity['analysisStatus']
  cloudAnalysisError?: string
  publicationStatus: MaterialPublicationStatus
  publicationId?: string
  publicationRevision?: number
  publicationReviewReason?: string
}

type MaterialCloudOperationType = 'upload' | 'delete_cloud_copy' | 'sync_material' | 'sync_folder' | 'sync_analysis' | 'restore_analysis' | 'update_generation'
type MaterialCloudOperationStatus = 'queued' | 'processing' | 'paused' | 'canceled' | 'succeeded' | 'failed'

interface MaterialCloudOperation {
  operationId: string
  operationType: MaterialCloudOperationType
  entityId: string
  payload: Record<string, unknown>
  status: MaterialCloudOperationStatus
  attemptCount: number
  nextRetryAt: string
  lastError?: string
}

interface MaterialTransferSession {
  sessionId: string
  direction: 'upload' | 'download'
  materialId: string
  status: string
  bytesTransferred: number
  totalBytes: number
  partSize: number
  completedParts: number[]
  tempRelativePath?: string
  lastError?: string
}

interface CloudMaterialRecord {
  materialId: string
  assetId: string
  assetVersion: number
  folderId: string
  displayName: string
  origin: MaterialOrigin
  addedFrom: MaterialAddedFrom
  sourceSha256: string
  sourceSize: number
  mimeType: string
  analysisStatus: MaterialFileIdentity['analysisStatus']
  analysisError?: string
  cloudStatus: MaterialFileIdentity['cloudStatus']
  cloudError?: string
  revision: number
  publicationStatus: MaterialPublicationStatus
  publicationId?: string
  publicationRevision?: number
  publicationReviewReason?: string
}

interface CloudFolderRecord {
  folderId: string
  parentFolderId?: string
  name: string
  revision: number
}

interface RegisterMaterialFileOptions {
  folderId: string
  origin: MaterialOrigin
  addedFrom: MaterialAddedFrom
  sourceSha256?: string
  sourceSize?: number
}

interface ImportMaterialFileProgress {
  phase: 'copying' | 'verifying'
  bytesProcessed: number
  totalBytes: number
}

interface ImportMaterialFileAsyncOptions {
  stagingDirectory: string
  isCanceled?: () => boolean
  onProgress?: (progress: ImportMaterialFileProgress) => void
}

interface TaskDraftRecord<T = unknown> {
  taskId: string
  schemaVersion: number
  revision: number
  snapshot: T
  saveStatus: 'saved'
  updatedAt: string
}

interface SaveTaskDraftOptions<T = unknown> {
  taskId: string
  schemaVersion: number
  expectedRevision?: number
  snapshot: T
}

interface GenerationManifestItem {
  material_id: string
  asset_id: string
  asset_version: number
  source_sha256: string
  local_path: string
}

interface GenerationManifestShot {
  shot_id: string
  materials: GenerationManifestItem[]
}

interface GenerationMaterialManifest {
  schema_version: 1
  run_id: string
  task_id: string
  task_revision: number
  resolved_at: string
  shots: GenerationManifestShot[]
}

interface PrepareGenerationManifestOptions {
  taskId: string
  taskRevision: number
  resumeRunPath?: string
  shots: Array<{
    shot_id?: unknown
    download_material?: unknown
    material_bindings?: unknown
  }>
}

interface FrozenGenerationManifestInput {
  runId: string
  taskId: string
  taskRevision: number
  resumeOptions?: PrepareGenerationManifestOptions
  shots: Array<{
    shot_id: string
    materials: Array<{
      material_id: string
      asset_id: string
      asset_version: number
      source_sha256: string
    }>
  }>
}

interface MaterialLocalStoreOptions {
  dataRoot: string
  materialsDir: string
  runsDir: string
  databasePath: string
  manifestsDir: string
}

interface MaterialIdentityStore {
  getMaterialReadRevision?(): string
  withMaterialReadSnapshot?<T>(read: () => T): T
  summarizeMaterialSelection(bindings: unknown): MaterialSelectionSummary
  getDeletionImpact(materialIds: string[], folderIds: string[]): MaterialDeletionImpact
  getFolder(folderId: string): MaterialFolderIdentity | null
  listFolders(scope: MaterialFolderScope): MaterialFolderIdentity[]
  isFolderStorageDeleted(scope: MaterialFolderScope, storageKey: string): boolean
  getMaterialCloudFileById(materialId: unknown): MaterialCloudFile | null
  getOrCreateFolder(input: MaterialFolderIdentityInput): string
  getMaterialCloudFileByPath(filePath: unknown): MaterialCloudFile | null
  moveFolder(folderId: string, storageKey: string, name: string, parentFolderId?: string): void
  moveMaterial(materialId: string, folderId: string): void
  removeLocalCopy(materialId: string): void
  deleteFolder(folderId: string): void
  deleteFile(filePath: string): void
  moveFile(previousPath: string, nextPath: string, folderId?: string): void
  setAnalysisStatusForFile(
    filePath: string,
    status: MaterialFileIdentity['analysisStatus'],
    error?: string,
  ): void
  listFolderFiles(folderId: string): FileEntry[]
  listCloudFiles(): FileEntry[]
  importMaterialFile(sourcePath: string, destinationDirectory: string, folderId: string): FileEntry
  importMaterialFileWithProgress(
    sourcePath: string,
    destinationDirectory: string,
    folderId: string,
    options: ImportMaterialFileAsyncOptions,
  ): Promise<FileEntry>
  describeFile(
    file: FileEntry,
    folderId: string,
    origin: MaterialOrigin,
    addedFrom: MaterialAddedFrom,
  ): FileEntry
  describeKnownFile(file: FileEntry): FileEntry
}

interface MaterialDeletionImpact {
  materialCount: number
  folderCount: number
  localFileCount: number
  cloudCopyCount: number
  publicMaterialCount: number
  taskReferenceCount: number
  canDelete: boolean
  blockers: string[]
}

type SqlRow = Record<string, unknown>

interface MaterialPresentationRows {
  uploads: Map<string, SqlRow>
  analyses: Map<string, SqlRow>
  transfers: Map<string, SqlRow>
}

interface MaterialReadSnapshot {
  revision?: string
  presentation?: MaterialPresentationRows
  presentationIds: Set<string>
  presentationFolders: Set<string>
  allPresentationLoaded: boolean
  files: Map<string, { rowSignature: string; file: FileEntry }>
}

const SCHEMA_VERSION = 7

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function numberValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeStorageKey(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return normalized || '.'
}

function normalizeAbsolutePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved
}

function isInsideDirectory(target: string, boundary: string): boolean {
  const relative = path.relative(normalizeAbsolutePath(boundary), normalizeAbsolutePath(target))
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function computeSha256(filePath: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function filesHaveSameContent(leftPath: string, rightPath: string, expectedSize: number): boolean {
  const left = path.resolve(leftPath)
  const right = path.resolve(rightPath)
  if (normalizeAbsolutePath(left) === normalizeAbsolutePath(right)) return true
  const leftStat = fs.statSync(left)
  const rightStat = fs.statSync(right)
  if (
    !leftStat.isFile()
    || !rightStat.isFile()
    || leftStat.size !== expectedSize
    || rightStat.size !== expectedSize
  ) {
    return false
  }

  const leftDescriptor = fs.openSync(left, 'r')
  const rightDescriptor = fs.openSync(right, 'r')
  const leftBuffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  const rightBuffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let offset = 0
    while (offset < expectedSize) {
      const length = Math.min(leftBuffer.length, expectedSize - offset)
      const leftRead = fs.readSync(leftDescriptor, leftBuffer, 0, length, offset)
      const rightRead = fs.readSync(rightDescriptor, rightBuffer, 0, length, offset)
      if (
        leftRead !== rightRead
        || !leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))
      ) {
        return false
      }
      if (leftRead === 0) break
      offset += leftRead
    }
    return offset === expectedSize
  } finally {
    fs.closeSync(leftDescriptor)
    fs.closeSync(rightDescriptor)
  }
}

function parseMaterialBindings(value: unknown): MaterialBindingInput[] {
  if (!Array.isArray(value)) return []
  const bindings: MaterialBindingInput[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.binding_type === 'material') {
      const materialId = stringValue(record.material_id).trim()
      const key = `material:${materialId}`
      if (materialId && !seen.has(key)) {
        bindings.push({ binding_type: 'material', material_id: materialId })
        seen.add(key)
      }
      continue
    }
    if (record.binding_type === 'folder') {
      const folderId = stringValue(record.folder_id).trim()
      const key = `folder:${folderId}`
      if (folderId && !seen.has(key)) {
        bindings.push({
          binding_type: 'folder',
          folder_id: folderId,
          include_subfolders: record.include_subfolders === true,
        })
        seen.add(key)
      }
    }
  }
  return bindings
}

function createMaterialLocalStore({
  dataRoot,
  materialsDir,
  runsDir,
  databasePath,
  manifestsDir,
}: MaterialLocalStoreOptions) {
  ensureDir(path.dirname(databasePath))
  ensureDir(manifestsDir)
  const database = new DatabaseSync(databasePath)
  const readIdentity = `${path.resolve(databasePath)}:${randomUUID()}`
  const ownReadRevision = database.prepare('SELECT total_changes() AS revision')
  const externalReadRevision = database.prepare('PRAGMA data_version')
  let materialReadSnapshot: MaterialReadSnapshot | undefined

  function getMaterialReadRevision(): string {
    const own = ownReadRevision.get() as SqlRow
    const external = externalReadRevision.get() as SqlRow
    return `${readIdentity}:${numberValue(own.revision)}:${numberValue(external.data_version)}`
  }

  function withMaterialReadSnapshot<T>(read: () => T): T {
    if (materialReadSnapshot) return read()
    materialReadSnapshot = { presentationIds: new Set(), presentationFolders: new Set(), allPresentationLoaded: false, files: new Map() }
    try {
      return read()
    } finally {
      materialReadSnapshot = undefined
    }
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_meta (
      schema_version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS material_folder (
      folder_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      parent_folder_id TEXT,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      cloud_revision INTEGER NOT NULL DEFAULT 0,
      publication_status TEXT NOT NULL DEFAULT 'private',
      publication_id TEXT,
      publication_revision INTEGER,
      publication_review_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(scope, storage_key)
    );

    CREATE TABLE IF NOT EXISTS asset (
      asset_id TEXT NOT NULL,
      asset_version INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      origin TEXT NOT NULL,
      analysis_status TEXT NOT NULL DEFAULT 'pending',
      analysis_error TEXT,
      cloud_analysis_status TEXT NOT NULL DEFAULT 'pending',
      cloud_analysis_error TEXT,
      cloud_status TEXT NOT NULL DEFAULT 'not_uploaded',
      cloud_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(asset_id, asset_version)
    );

    CREATE INDEX IF NOT EXISTS idx_asset_sha256_size
      ON asset(source_sha256, source_size);

    CREATE TABLE IF NOT EXISTS material (
      material_id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      local_folder_id TEXT,
      cloud_folder_id TEXT,
      asset_id TEXT NOT NULL,
      asset_version INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      added_from TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      cloud_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(folder_id) REFERENCES material_folder(folder_id),
      FOREIGN KEY(asset_id, asset_version) REFERENCES asset(asset_id, asset_version)
    );

    CREATE INDEX IF NOT EXISTS idx_material_folder
      ON material(folder_id, deleted_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS local_asset_file (
      local_file_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      asset_version INTEGER NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      source_sha256 TEXT NOT NULL,
      source_size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      local_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(asset_id, asset_version) REFERENCES asset(asset_id, asset_version)
    );

    CREATE INDEX IF NOT EXISTS idx_local_asset_fingerprint
      ON local_asset_file(source_sha256, source_size);

    CREATE TABLE IF NOT EXISTS local_material_file_map (
      material_id TEXT PRIMARY KEY,
      local_file_id TEXT NOT NULL,
      FOREIGN KEY(material_id) REFERENCES material(material_id),
      FOREIGN KEY(local_file_id) REFERENCES local_asset_file(local_file_id)
    );

    CREATE TABLE IF NOT EXISTS local_task_draft (
      task_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      save_status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_sync_outbox (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_local_sync_outbox_due
      ON local_sync_outbox(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_local_sync_outbox_entity_status
      ON local_sync_outbox(entity_id, operation_type, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS local_transfer_session (
      session_id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      material_id TEXT NOT NULL,
      status TEXT NOT NULL,
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL,
      part_size INTEGER NOT NULL DEFAULT 0,
      completed_parts_json TEXT NOT NULL DEFAULT '[]',
      temp_relative_path TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(material_id) REFERENCES material(material_id)
    );

    CREATE INDEX IF NOT EXISTS idx_local_transfer_material
      ON local_transfer_session(material_id, direction, updated_at DESC);

    CREATE TABLE IF NOT EXISTS local_cloud_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_sync_conflict (
      conflict_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      local_revision INTEGER NOT NULL,
      base_cloud_revision INTEGER NOT NULL,
      incoming_cloud_revision INTEGER NOT NULL,
      cloud_payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uk_local_sync_conflict_unresolved
      ON local_sync_conflict(entity_type, entity_id)
      WHERE status = 'unresolved';

    CREATE INDEX IF NOT EXISTS idx_local_sync_conflict_status
      ON local_sync_conflict(status, updated_at DESC);
  `)

  const assetColumns = database.prepare('PRAGMA table_info(asset)').all() as SqlRow[]
  if (!assetColumns.some((column) => stringValue(column.name) === 'analysis_error')) {
    database.exec('ALTER TABLE asset ADD COLUMN analysis_error TEXT')
  }
  if (!assetColumns.some((column) => stringValue(column.name) === 'cloud_error')) {
    database.exec('ALTER TABLE asset ADD COLUMN cloud_error TEXT')
  }
  if (!assetColumns.some((column) => stringValue(column.name) === 'cloud_analysis_status')) {
    database.exec("ALTER TABLE asset ADD COLUMN cloud_analysis_status TEXT NOT NULL DEFAULT 'pending'")
  }
  if (!assetColumns.some((column) => stringValue(column.name) === 'cloud_analysis_error')) {
    database.exec('ALTER TABLE asset ADD COLUMN cloud_analysis_error TEXT')
  }
  const materialColumns = database.prepare('PRAGMA table_info(material)').all() as SqlRow[]
  if (!materialColumns.some((column) => stringValue(column.name) === 'cloud_revision')) {
    database.exec('ALTER TABLE material ADD COLUMN cloud_revision INTEGER NOT NULL DEFAULT 0')
  }
  if (!materialColumns.some((column) => stringValue(column.name) === 'publication_status')) {
    database.exec("ALTER TABLE material ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'private'")
  }
  if (!materialColumns.some((column) => stringValue(column.name) === 'publication_id')) {
    database.exec('ALTER TABLE material ADD COLUMN publication_id TEXT')
  }
  if (!materialColumns.some((column) => stringValue(column.name) === 'publication_revision')) {
    database.exec('ALTER TABLE material ADD COLUMN publication_revision INTEGER')
  }
  if (!materialColumns.some((column) => stringValue(column.name) === 'publication_review_reason')) {
    database.exec('ALTER TABLE material ADD COLUMN publication_review_reason TEXT')
  }
  if (!materialColumns.some((column) => stringValue(column.name) === 'local_folder_id')) {
    database.exec('ALTER TABLE material ADD COLUMN local_folder_id TEXT')
  }
  if (!materialColumns.some((column) => stringValue(column.name) === 'cloud_folder_id')) {
    database.exec('ALTER TABLE material ADD COLUMN cloud_folder_id TEXT')
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_material_local_folder
      ON material(local_folder_id, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_material_cloud_folder
      ON material(cloud_folder_id, deleted_at, updated_at DESC);
    UPDATE material
    SET local_folder_id = folder_id
    WHERE local_folder_id IS NULL
      AND folder_id IN (
        SELECT folder_id FROM material_folder WHERE scope = 'user'
      );
    UPDATE material
    SET cloud_folder_id = folder_id
    WHERE cloud_folder_id IS NULL
      AND (
        cloud_revision > 0
        OR folder_id IN (
          SELECT folder_id FROM material_folder WHERE scope = 'downloads'
        )
      );
  `)
  const folderColumns = database.prepare('PRAGMA table_info(material_folder)').all() as SqlRow[]
  if (!folderColumns.some((column) => stringValue(column.name) === 'cloud_revision')) {
    database.exec('ALTER TABLE material_folder ADD COLUMN cloud_revision INTEGER NOT NULL DEFAULT 0')
  }
  database.exec(`
    DROP INDEX IF EXISTS uk_local_sync_outbox_active;
    CREATE UNIQUE INDEX IF NOT EXISTS uk_local_sync_outbox_queued
      ON local_sync_outbox(operation_type, entity_id)
      WHERE status = 'queued';
  `)

  const outboxRecoveryTimestamp = new Date().toISOString()
  database.exec('BEGIN IMMEDIATE')
  try {
    database.prepare(`
      UPDATE local_sync_outbox AS stale
      SET status = 'canceled',
          last_error = COALESCE(last_error, '应用重启时已由同资源的较新同步操作替代'),
          updated_at = ?
      WHERE stale.status = 'processing'
        AND EXISTS (
          SELECT 1
          FROM local_sync_outbox AS preferred
          WHERE preferred.operation_type = stale.operation_type
            AND preferred.entity_id = stale.entity_id
            AND (
              preferred.status = 'queued'
              OR (
                preferred.status = 'processing'
                AND (
                  preferred.updated_at > stale.updated_at
                  OR (
                    preferred.updated_at = stale.updated_at
                    AND preferred.operation_id > stale.operation_id
                  )
                )
              )
            )
        )
    `).run(outboxRecoveryTimestamp)
    database.prepare(`
      UPDATE local_sync_outbox
      SET status = 'queued', next_retry_at = ?, updated_at = ?
      WHERE status = 'processing'
    `).run(outboxRecoveryTimestamp, outboxRecoveryTimestamp)
    database.prepare(`
      UPDATE local_transfer_session AS transfer
      SET status = 'ready',
          bytes_transferred = total_bytes,
          last_error = NULL,
          updated_at = ?
      WHERE transfer.direction = 'upload'
        AND transfer.status <> 'ready'
        AND EXISTS (
          SELECT 1
          FROM material
          JOIN asset
            ON asset.asset_id = material.asset_id
           AND asset.asset_version = material.asset_version
          WHERE material.material_id = transfer.material_id
            AND asset.cloud_status = 'ready'
        )
    `).run(outboxRecoveryTimestamp)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  const existingSchema = database.prepare('SELECT schema_version FROM schema_meta LIMIT 1').get() as SqlRow | undefined
  if (!existingSchema) {
    database.prepare('INSERT INTO schema_meta(schema_version) VALUES (?)').run(SCHEMA_VERSION)
  } else if ([1, 2, 3, 4, 5, 6].includes(numberValue(existingSchema.schema_version))) {
    database.prepare('UPDATE schema_meta SET schema_version = ?').run(SCHEMA_VERSION)
  } else if (numberValue(existingSchema.schema_version) !== SCHEMA_VERSION) {
    throw new Error(`不支持的素材数据库版本：${stringValue(existingSchema.schema_version)}`)
  }

  function now(): string {
    return new Date().toISOString()
  }

  function recordSyncConflict(
    entityType: 'folder' | 'material',
    entityId: string,
    localRevision: number,
    baseCloudRevision: number,
    incomingCloudRevision: number,
    cloudPayload: Record<string, unknown>,
  ): void {
    const timestamp = now()
    const existing = database.prepare(`
      SELECT conflict_id FROM local_sync_conflict
      WHERE entity_type = ? AND entity_id = ? AND status = 'unresolved'
    `).get(entityType, entityId) as SqlRow | undefined
    if (existing) {
      database.prepare(`
        UPDATE local_sync_conflict
        SET local_revision = ?, base_cloud_revision = ?, incoming_cloud_revision = ?,
            cloud_payload_json = ?, updated_at = ?
        WHERE conflict_id = ?
      `).run(
        localRevision,
        baseCloudRevision,
        incomingCloudRevision,
        JSON.stringify(cloudPayload),
        timestamp,
        stringValue(existing.conflict_id),
      )
      return
    }
    database.prepare(`
      INSERT INTO local_sync_conflict(
        conflict_id, entity_type, entity_id, local_revision, base_cloud_revision,
        incoming_cloud_revision, cloud_payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?)
    `).run(
      `conflict_${randomUUID().replaceAll('-', '')}`,
      entityType,
      entityId,
      localRevision,
      baseCloudRevision,
      incomingCloudRevision,
      JSON.stringify(cloudPayload),
      timestamp,
      timestamp,
    )
  }

  function resolveSyncConflict(entityType: 'folder' | 'material', entityId: string): void {
    const timestamp = now()
    database.prepare(`
      UPDATE local_sync_conflict
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE entity_type = ? AND entity_id = ? AND status = 'unresolved'
    `).run(timestamp, timestamp, entityType, entityId)
  }

  function cloudConflictCount(): number {
    const row = database.prepare(`
      SELECT count(*) AS count FROM local_sync_conflict WHERE status = 'unresolved'
    `).get() as SqlRow
    return numberValue(row.count)
  }

  function relativePathFor(filePath: string): string {
    const resolved = path.resolve(filePath)
    if (!isInsideDirectory(resolved, dataRoot)) {
      throw new Error('素材文件不在托管工作目录中')
    }
    return normalizeStorageKey(path.relative(dataRoot, resolved))
  }

  function absolutePathFor(relativePath: string): string {
    const resolved = path.resolve(dataRoot, relativePath)
    if (!isInsideDirectory(resolved, dataRoot)) {
      throw new Error('素材文件映射超出托管工作目录')
    }
    return resolved
  }

  function getFolder(folderId: string): MaterialFolderIdentity | null {
    const row = database.prepare(`
      SELECT folder_id, scope, storage_key, parent_folder_id, name, revision, cloud_revision
      FROM material_folder
      WHERE folder_id = ? AND deleted_at IS NULL
    `).get(folderId) as SqlRow | undefined
    if (!row) return null
    return {
      folderId: stringValue(row.folder_id),
      scope: stringValue(row.scope) as MaterialFolderScope,
      storageKey: stringValue(row.storage_key),
      name: stringValue(row.name),
      parentFolderId: stringValue(row.parent_folder_id) || undefined,
      revision: numberValue(row.revision) || 1,
      cloudRevision: numberValue(row.cloud_revision),
    }
  }

  function listFolders(scope: MaterialFolderScope): MaterialFolderIdentity[] {
    const rows = database.prepare(`
      SELECT folder_id, scope, storage_key, parent_folder_id, name, revision, cloud_revision
      FROM material_folder
      WHERE scope = ? AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE, folder_id
    `).all(scope) as SqlRow[]
    return rows.map((row) => ({
      folderId: stringValue(row.folder_id),
      scope: stringValue(row.scope) as MaterialFolderScope,
      storageKey: stringValue(row.storage_key),
      name: stringValue(row.name),
      parentFolderId: stringValue(row.parent_folder_id) || undefined,
      revision: numberValue(row.revision) || 1,
      cloudRevision: numberValue(row.cloud_revision),
    }))
  }

  function isFolderStorageDeleted(scope: MaterialFolderScope, storageKey: string): boolean {
    const normalized = normalizeStorageKey(storageKey)
    const row = database.prepare(`
      SELECT 1
      FROM material_folder
      WHERE scope = ? AND deleted_at IS NOT NULL
        AND storage_key LIKE ?
      LIMIT 1
    `).get(scope, `${normalized}#deleted:%`) as SqlRow | undefined
    return Boolean(row)
  }

  function getCloudFolderRecord(folderIdValue: unknown): CloudFolderRecord | null {
    const folderId = stringValue(folderIdValue).trim()
    const folder = getFolder(folderId)
    if (!folder || folder.scope === 'virtual') return null
    const row = database.prepare(`
      SELECT revision FROM material_folder WHERE folder_id = ? AND deleted_at IS NULL
    `).get(folderId) as SqlRow | undefined
    if (!row) return null
    const parent = folder.parentFolderId ? getFolder(folder.parentFolderId) : null
    return {
      folderId,
      parentFolderId: parent && parent.scope !== 'virtual' ? parent.folderId : undefined,
      name: folder.name,
      revision: numberValue(row.revision) || 1,
    }
  }

  function getOrCreateFolder(input: MaterialFolderIdentityInput): string {
    const storageKey = normalizeStorageKey(input.storageKey)
    const existing = database.prepare(`
      SELECT folder_id
      FROM material_folder
      WHERE scope = ? AND storage_key = ? AND deleted_at IS NULL
    `).get(input.scope, storageKey) as SqlRow | undefined
    if (existing) return stringValue(existing.folder_id)

    const folderId = `fld_${randomUUID().replaceAll('-', '')}`
    const timestamp = now()
    database.prepare(`
      INSERT INTO material_folder(
        folder_id, scope, storage_key, parent_folder_id, name,
        revision, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      folderId,
      input.scope,
      storageKey,
      input.parentFolderId || null,
      input.name,
      timestamp,
      timestamp,
    )
    return folderId
  }

  function moveFolder(
    folderId: string,
    nextStorageKey: string,
    name: string,
    nextParentFolderId?: string,
  ): void {
    const folder = getFolder(folderId)
    if (!folder) throw new Error('无效的素材文件夹')
    const previousPrefix = normalizeStorageKey(folder.storageKey)
    const nextPrefix = normalizeStorageKey(nextStorageKey)
    const timestamp = now()
    const rows = database.prepare(`
      SELECT folder_id, storage_key
      FROM material_folder
      WHERE scope = ? AND deleted_at IS NULL
    `).all(folder.scope) as SqlRow[]

    database.exec('BEGIN IMMEDIATE')
    try {
      if (folder.scope === 'user' || folder.scope === 'downloads') {
        const scopeDirectory = folder.scope === 'user' ? materialsDir : runsDir
        const scopeRoot = normalizeStorageKey(path.relative(dataRoot, scopeDirectory))
        const previousFilePrefix = previousPrefix === '.'
          ? scopeRoot
          : `${scopeRoot}/${previousPrefix}`
        const nextFilePrefix = nextPrefix === '.'
          ? scopeRoot
          : `${scopeRoot}/${nextPrefix}`
        const fileRows = database.prepare(`
          SELECT local_file_id, relative_path
          FROM local_asset_file
          WHERE relative_path = ? OR relative_path LIKE ?
        `).all(previousFilePrefix, `${previousFilePrefix}/%`) as SqlRow[]
        for (const row of fileRows) {
          const relativePath = normalizeStorageKey(stringValue(row.relative_path))
          const suffix = relativePath === previousFilePrefix
            ? ''
            : relativePath.slice(previousFilePrefix.length + 1)
          database.prepare(`
            UPDATE local_asset_file
            SET relative_path = ?, updated_at = ?
            WHERE local_file_id = ?
          `).run(
            suffix ? `${nextFilePrefix}/${suffix}` : nextFilePrefix,
            timestamp,
            stringValue(row.local_file_id),
          )
        }
      }

      for (const row of rows) {
        const storageKey = normalizeStorageKey(stringValue(row.storage_key))
        if (storageKey !== previousPrefix && !storageKey.startsWith(`${previousPrefix}/`)) continue
        const suffix = storageKey === previousPrefix ? '' : storageKey.slice(previousPrefix.length + 1)
        const movedKey = suffix ? `${nextPrefix}/${suffix}` : nextPrefix
        database.prepare(`
          UPDATE material_folder
          SET storage_key = ?,
              name = CASE WHEN folder_id = ? THEN ? ELSE name END,
              parent_folder_id = CASE WHEN folder_id = ? AND ? IS NOT NULL THEN ? ELSE parent_folder_id END,
              revision = CASE WHEN folder_id = ? THEN revision + 1 ELSE revision END,
              updated_at = ?
          WHERE folder_id = ?
        `).run(
          movedKey,
          folderId,
          name,
          folderId,
          nextParentFolderId || null,
          nextParentFolderId || null,
          folderId,
          timestamp,
          stringValue(row.folder_id),
        )
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    const record = getCloudFolderRecord(folderId)
    if (record) queueCloudOperation('sync_folder', folderId, {})
  }

  function deleteFolder(folderId: string): void {
    const folder = getFolder(folderId)
    if (!folder) return
    const prefix = normalizeStorageKey(folder.storageKey)
    const timestamp = now()
    const rows = database.prepare(`
      WITH RECURSIVE subtree(folder_id) AS (
        SELECT folder_id FROM material_folder WHERE folder_id = ? AND deleted_at IS NULL
        UNION
        SELECT child.folder_id
        FROM material_folder child
        JOIN subtree parent ON child.parent_folder_id = parent.folder_id
        WHERE child.deleted_at IS NULL
      )
      SELECT folder_id, storage_key, revision, cloud_revision
      FROM material_folder
      WHERE deleted_at IS NULL
        AND (
          folder_id IN (SELECT folder_id FROM subtree)
          OR (scope = ? AND (storage_key = ? OR storage_key LIKE ?))
        )
    `).all(folder.folderId, folder.scope, prefix, `${prefix}/%`) as SqlRow[]
    const deletedMaterials = database.prepare(`
      WITH RECURSIVE subtree(folder_id) AS (
        SELECT folder_id FROM material_folder WHERE folder_id = ? AND deleted_at IS NULL
        UNION
        SELECT child.folder_id
        FROM material_folder child
        JOIN subtree parent ON child.parent_folder_id = parent.folder_id
        WHERE child.deleted_at IS NULL
      )
      SELECT m.material_id, m.revision, m.cloud_revision, a.cloud_status
      FROM material m
      JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
      WHERE m.deleted_at IS NULL
        AND m.folder_id IN (
          SELECT folder_id FROM material_folder
          WHERE deleted_at IS NULL
            AND (
              folder_id IN (SELECT folder_id FROM subtree)
              OR (scope = ? AND (storage_key = ? OR storage_key LIKE ?))
            )
        )
    `).all(folder.folderId, folder.scope, prefix, `${prefix}/%`) as SqlRow[]
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const deletedFolderId = stringValue(row.folder_id)
        database.prepare(`
          UPDATE local_asset_file
          SET local_status = 'missing', updated_at = ?
          WHERE local_file_id IN (
            SELECT map.local_file_id
            FROM local_material_file_map map
            JOIN material m ON m.material_id = map.material_id
            WHERE m.folder_id = ?
          )
        `).run(timestamp, deletedFolderId)
        database.prepare(`
          UPDATE material
          SET deleted_at = ?, revision = revision + 1, updated_at = ?
          WHERE folder_id = ? AND deleted_at IS NULL
        `).run(timestamp, timestamp, deletedFolderId)
        const tombstoneKey = `${stringValue(row.storage_key)}#deleted:${stringValue(row.folder_id)}`
        database.prepare(`
          UPDATE material_folder
          SET storage_key = ?, deleted_at = ?, revision = revision + 1, updated_at = ?
          WHERE folder_id = ?
        `).run(tombstoneKey, timestamp, timestamp, stringValue(row.folder_id))
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    for (const material of deletedMaterials) {
      const hasCloudRecord = numberValue(material.cloud_revision) > 0
        || stringValue(material.cloud_status) !== 'not_uploaded'
      if (!hasCloudRecord) continue
      queueCloudOperation('sync_material', stringValue(material.material_id), {
        deleted: true,
        revision: Math.max(1, numberValue(material.cloud_revision)),
      })
    }
    for (const row of [...rows].sort((left, right) => (
      stringValue(right.storage_key).length - stringValue(left.storage_key).length
    ))) {
      queueCloudOperation('sync_folder', stringValue(row.folder_id), {
        deleted: true,
        revision: Math.max(1, numberValue(row.cloud_revision)),
      })
    }
  }

  function materialIdentityFromRow(row: SqlRow): MaterialFileIdentity {
    const localFolderId = stringValue(row.local_folder_id) || undefined
    const cloudFolderId = stringValue(row.cloud_folder_id) || undefined
    return {
      materialId: stringValue(row.material_id),
      assetId: stringValue(row.asset_id),
      assetVersion: numberValue(row.asset_version),
      sourceSha256: stringValue(row.source_sha256),
      localStatus: stringValue(row.local_status) as MaterialFileIdentity['localStatus'],
      analysisStatus: stringValue(row.analysis_status) as MaterialFileIdentity['analysisStatus'],
      analysisError: stringValue(row.analysis_error) || undefined,
      cloudAnalysisStatus: (stringValue(row.cloud_analysis_status) || undefined) as MaterialFileIdentity['analysisStatus'] | undefined,
      cloudAnalysisError: stringValue(row.cloud_analysis_error) || undefined,
      cloudStatus: stringValue(row.cloud_status) as MaterialFileIdentity['cloudStatus'],
      cloudError: stringValue(row.cloud_error) || undefined,
      folderId: localFolderId || cloudFolderId || stringValue(row.folder_id),
      localFolderId,
      cloudFolderId,
      localPath: absolutePathFor(stringValue(row.relative_path)),
    }
  }

  function reconcileLocalFileState(
    row: SqlRow,
    verifyContent = false,
  ): MaterialFileIdentity['localStatus'] {
    const localFileId = stringValue(row.local_file_id)
    const previousStatus = stringValue(row.local_status) as MaterialFileIdentity['localStatus']
    const expectedSize = numberValue(row.source_size)
    const expectedHash = stringValue(row.source_sha256).toLocaleLowerCase()
    const storedMtime = numberValue(row.mtime)
    let status: MaterialFileIdentity['localStatus']
    let mtime = storedMtime
    try {
      const filePath = absolutePathFor(stringValue(row.relative_path))
      const stat = fs.lstatSync(filePath)
      mtime = stat.mtimeMs
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize) {
        status = 'damaged'
      } else if (
        !verifyContent
        && previousStatus === 'present'
        && Math.abs(stat.mtimeMs - storedMtime) < 0.5
      ) {
        status = 'present'
      } else {
        status = computeSha256(filePath) === expectedHash ? 'present' : 'damaged'
      }
    } catch (error) {
      const code = stringValue((error as NodeJS.ErrnoException)?.code)
      status = code === 'ENOENT' ? 'missing' : 'damaged'
    }
    if (localFileId && (status !== previousStatus || (status === 'present' && mtime !== storedMtime))) {
      database.prepare(`
        UPDATE local_asset_file
        SET local_status = ?, mtime = ?, updated_at = ?
        WHERE local_file_id = ?
      `).run(status, mtime, now(), localFileId)
    }
    row.local_status = status
    row.mtime = mtime
    return status
  }

  function findMaterialByRelativePath(relativePath: string) {
    return database.prepare(`
      SELECT
        m.material_id, m.folder_id, m.local_folder_id, m.cloud_folder_id,
        m.asset_id, m.asset_version, m.display_name,
        f.local_file_id, f.relative_path, f.source_sha256, f.source_size, f.mtime, f.local_status,
        a.analysis_status, a.analysis_error, a.cloud_status, a.cloud_error,
        a.cloud_analysis_status, a.cloud_analysis_error
      FROM local_asset_file f
      JOIN local_material_file_map map ON map.local_file_id = f.local_file_id
      JOIN material m ON m.material_id = map.material_id
      JOIN asset a ON a.asset_id = m.asset_id AND a.asset_version = m.asset_version
      WHERE f.relative_path = ?
        AND m.deleted_at IS NULL
      LIMIT 1
    `).get(relativePath) as SqlRow | undefined
  }

  function findReusableAsset(
    sourcePath: string,
    sourceSha256: string,
    sourceSize: number,
  ): SqlRow | undefined {
    const candidates = database.prepare(`
      SELECT a.asset_id, a.asset_version, f.relative_path
      FROM asset a
      JOIN local_asset_file f
        ON f.asset_id = a.asset_id AND f.asset_version = a.asset_version
      WHERE a.source_sha256 = ?
        AND a.source_size = ?
        AND f.local_status = 'present'
      ORDER BY a.created_at, f.created_at
    `).all(sourceSha256, sourceSize) as SqlRow[]
    for (const candidate of candidates) {
      const candidatePath = absolutePathFor(stringValue(candidate.relative_path))
      if (
        fs.existsSync(candidatePath)
        && filesHaveSameContent(sourcePath, candidatePath, sourceSize)
      ) {
        return candidate
      }
    }
    return undefined
  }

  function registerMaterialFile(
    filePath: string,
    options: RegisterMaterialFileOptions,
  ): MaterialFileIdentity {
    const resolved = path.resolve(filePath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('素材文件不存在')
    if (!VIDEO_EXTENSIONS.includes(path.extname(resolved).toLocaleLowerCase())) {
      throw new Error('文件不是支持的视频素材')
    }
    const relativePath = relativePathFor(resolved)
    const cached = findMaterialByRelativePath(relativePath)
    if (isInsideDirectory(resolved, path.join(materialsDir, 'cloud'))) {
      if (!cached) throw new Error('当前账号没有此云端素材记录，请先同步当前账号的素材库')
      // A downloaded cache path is storage, never a user folder assignment.
      // Reusing it must retain the current account's original cloud folder chain.
      reconcileLocalFileState(cached)
      return materialIdentityFromRow(cached)
    }
    if (cached) {
      reconcileLocalFileState(cached)
      const materialId = stringValue(cached.material_id)
      const displayName = path.basename(resolved)
      const folderChanged = stringValue(cached.local_folder_id) !== options.folderId
      const nameChanged = stringValue(cached.display_name) !== displayName
      if (folderChanged || nameChanged) {
        const targetFolder = database.prepare(`
          SELECT folder_id FROM material_folder
          WHERE folder_id = ? AND deleted_at IS NULL
        `).get(options.folderId) as SqlRow | undefined
        if (!targetFolder) throw new Error('素材目标文件夹不存在')
        database.prepare(`
          UPDATE material
          SET local_folder_id = ?,
              folder_id = CASE WHEN cloud_folder_id IS NULL THEN ? ELSE folder_id END,
              display_name = ?, revision = revision + 1, updated_at = ?
          WHERE material_id = ? AND deleted_at IS NULL
        `).run(options.folderId, options.folderId, displayName, now(), materialId)
        if (stringValue(cached.cloud_status) !== 'not_uploaded') {
          queueCloudOperation('sync_material', materialId, { repaired_folder: true })
        }
        const repaired = findMaterialByRelativePath(relativePath)
        if (!repaired) throw new Error('素材文件夹修复失败')
        reconcileLocalFileState(repaired)
        return materialIdentityFromRow(repaired)
      }
      return materialIdentityFromRow(cached)
    }

    const sourceSha256 = options.sourceSha256 || computeSha256(resolved)
    const sourceSize = options.sourceSize || stat.size
    if (sourceSize !== stat.size) throw new Error('素材文件大小校验失败')
    const timestamp = now()
    const reusableAsset = findReusableAsset(resolved, sourceSha256, sourceSize)

    database.exec('BEGIN IMMEDIATE')
    try {
      let assetRow = reusableAsset
      if (!assetRow) {
        const assetId = `asset_${randomUUID().replaceAll('-', '')}`
        database.prepare(`
          INSERT INTO asset(
            asset_id, asset_version, source_sha256, source_size, mime_type,
            original_file_name, origin, analysis_status, cloud_status, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, 'pending', 'not_uploaded', ?, ?)
        `).run(
          assetId,
          sourceSha256,
          sourceSize,
          `video/${path.extname(resolved).slice(1).toLocaleLowerCase() || 'unknown'}`,
          path.basename(resolved),
          options.origin,
          timestamp,
          timestamp,
        )
        assetRow = { asset_id: assetId, asset_version: 1 }
      }

      const previousFile = database.prepare(`
        SELECT local_file_id
        FROM local_asset_file
        WHERE relative_path = ?
      `).get(relativePath) as SqlRow | undefined
      const localFileId = stringValue(previousFile?.local_file_id)
        || `file_${randomUUID().replaceAll('-', '')}`
      database.prepare(`
        INSERT INTO local_asset_file(
          local_file_id, asset_id, asset_version, relative_path, source_sha256,
          source_size, mtime, local_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'present', ?, ?)
        ON CONFLICT(relative_path) DO UPDATE SET
          asset_id = excluded.asset_id,
          asset_version = excluded.asset_version,
          source_sha256 = excluded.source_sha256,
          source_size = excluded.source_size,
          mtime = excluded.mtime,
          local_status = 'present',
          updated_at = excluded.updated_at
      `).run(
        localFileId,
        stringValue(assetRow.asset_id),
        numberValue(assetRow.asset_version),
        relativePath,
        sourceSha256,
        sourceSize,
        stat.mtimeMs,
        timestamp,
        timestamp,
      )

      const mappedMaterial = database.prepare(`
        SELECT m.material_id, m.asset_id, m.asset_version, m.cloud_folder_id
        FROM local_material_file_map map
        JOIN material m ON m.material_id = map.material_id
        WHERE map.local_file_id = ? AND m.deleted_at IS NULL
        LIMIT 1
      `).get(localFileId) as SqlRow | undefined
      const assetChanged = Boolean(mappedMaterial) && (
        stringValue(mappedMaterial?.asset_id) !== stringValue(assetRow.asset_id)
        || numberValue(mappedMaterial?.asset_version) !== numberValue(assetRow.asset_version)
      )
      if (assetChanged) {
        database.prepare(`
          UPDATE material
          SET deleted_at = ?, revision = revision + 1, updated_at = ?
          WHERE material_id = ?
        `).run(timestamp, timestamp, stringValue(mappedMaterial?.material_id))
      }
      const materialId = mappedMaterial && !assetChanged
        ? stringValue(mappedMaterial.material_id)
        : `mat_${randomUUID().replaceAll('-', '')}`
      if (mappedMaterial && !assetChanged) {
        database.prepare(`
          UPDATE material
          SET local_folder_id = ?,
              folder_id = CASE WHEN cloud_folder_id IS NULL THEN ? ELSE folder_id END,
              display_name = ?, revision = revision + 1, updated_at = ?
          WHERE material_id = ?
        `).run(options.folderId, options.folderId, path.basename(resolved), timestamp, materialId)
      } else {
        database.prepare(`
          INSERT INTO material(
            material_id, folder_id, local_folder_id, cloud_folder_id,
            asset_id, asset_version, display_name,
            added_from, revision, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, NULL)
        `).run(
          materialId,
          options.folderId,
          options.folderId,
          stringValue(assetRow.asset_id),
          numberValue(assetRow.asset_version),
          path.basename(resolved),
          options.addedFrom,
          timestamp,
          timestamp,
        )
        database.prepare(`
          INSERT INTO local_material_file_map(material_id, local_file_id)
          VALUES (?, ?)
        `).run(materialId, localFileId)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }

    const stored = findMaterialByRelativePath(relativePath)
    if (!stored) throw new Error('素材身份写入失败')
    return materialIdentityFromRow(stored)
  }

  function reusableLocalPath(
    sourcePath: string,
    sourceSha256: string,
    sourceSize: number,
  ): string | null {
    const rows = database.prepare(`
      SELECT relative_path
      FROM local_asset_file
      WHERE source_sha256 = ?
        AND source_size = ?
        AND local_status = 'present'
      ORDER BY created_at
    `).all(sourceSha256, sourceSize) as SqlRow[]
    for (const row of rows) {
      const candidate = absolutePathFor(stringValue(row.relative_path))
      if (
        fs.existsSync(candidate)
        && filesHaveSameContent(sourcePath, candidate, sourceSize)
      ) {
        return candidate
      }
    }
    return null
  }

  function importMaterialFile(
    sourcePath: string,
    destinationDirectory: string,
    folderId: string,
  ): FileEntry {
    const source = path.resolve(sourcePath)
    const sourceStat = fs.lstatSync(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error('导入源文件不是可用的视频文件')
    }
    if (!VIDEO_EXTENSIONS.includes(path.extname(source).toLocaleLowerCase())) {
      throw new Error('文件不是支持的视频素材')
    }
    const destinationRoot = path.resolve(destinationDirectory)
    if (!isInsideDirectory(destinationRoot, materialsDir)) {
      throw new Error('导入目标不在托管素材目录中')
    }
    ensureDir(destinationRoot)

    const sourceSha256 = computeSha256(source)
    const reusablePath = reusableLocalPath(source, sourceSha256, sourceStat.size)
    const destination = createUniqueDestination(destinationRoot, source)
    const temporaryDestination = path.join(
      destinationRoot,
      `.${path.basename(destination)}.import-${process.pid}-${randomUUID()}.tmp`,
    )
    try {
      if (reusablePath) {
        try {
          fs.linkSync(reusablePath, temporaryDestination)
        } catch {
          fs.copyFileSync(reusablePath, temporaryDestination)
        }
      } else {
        fs.copyFileSync(source, temporaryDestination)
      }
      const copiedStat = fs.statSync(temporaryDestination)
      if (copiedStat.size !== sourceStat.size || computeSha256(temporaryDestination) !== sourceSha256) {
        throw new Error('导入素材复制校验失败')
      }
      fs.renameSync(temporaryDestination, destination)
      const file = createFileEntry(destination)
      return describeFile(file, folderId, 'user_upload', 'user_import')
    } catch (error) {
      try {
        if (fs.existsSync(temporaryDestination)) fs.unlinkSync(temporaryDestination)
        if (fs.existsSync(destination)) fs.unlinkSync(destination)
      } catch {
        // Preserve the import failure; cleanup is best effort.
      }
      throw error
    }
  }

  async function importMaterialFileWithProgress(
    sourcePath: string,
    destinationDirectory: string,
    folderId: string,
    options: ImportMaterialFileAsyncOptions,
  ): Promise<FileEntry> {
    const source = path.resolve(sourcePath)
    const sourceStat = await fs.promises.lstat(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error('导入源文件不是可用的视频文件')
    }
    if (!VIDEO_EXTENSIONS.includes(path.extname(source).toLocaleLowerCase())) {
      throw new Error('文件不是支持的视频素材')
    }
    const destinationRoot = path.resolve(destinationDirectory)
    const stagingRoot = path.resolve(options.stagingDirectory)
    if (!isInsideDirectory(destinationRoot, materialsDir)) {
      throw new Error('导入目标不在托管素材目录中')
    }
    if (!isInsideDirectory(stagingRoot, materialsDir)) {
      throw new Error('导入暂存目录不在托管素材目录中')
    }
    ensureDir(destinationRoot)
    ensureDir(stagingRoot)

    const assertNotCanceled = () => {
      if (options.isCanceled?.()) throw new Error('素材导入已取消')
    }
    const stagingPath = path.join(
      stagingRoot,
      `${randomUUID()}-${path.basename(source)}`,
    )
    const destination = createUniqueDestination(destinationRoot, source)
    let promoted = false
    let registered = false
    try {
      const sourceHash = createHash('sha256')
      const sourceHandle = await fs.promises.open(source, 'r')
      const destinationHandle = await fs.promises.open(stagingPath, 'wx')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let copied = 0
      try {
        while (copied < sourceStat.size) {
          assertNotCanceled()
          const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, copied)
          if (!bytesRead) break
          sourceHash.update(buffer.subarray(0, bytesRead))
          let written = 0
          while (written < bytesRead) {
            const result = await destinationHandle.write(
              buffer,
              written,
              bytesRead - written,
              copied + written,
            )
            written += result.bytesWritten
          }
          copied += bytesRead
          options.onProgress?.({ phase: 'copying', bytesProcessed: copied, totalBytes: sourceStat.size })
        }
      } finally {
        await Promise.allSettled([sourceHandle.close(), destinationHandle.close()])
      }
      if (copied !== sourceStat.size) throw new Error('导入素材复制大小不完整')

      const copiedHash = createHash('sha256')
      const verifyHandle = await fs.promises.open(stagingPath, 'r')
      let verified = 0
      try {
        while (verified < sourceStat.size) {
          assertNotCanceled()
          const { bytesRead } = await verifyHandle.read(buffer, 0, buffer.length, verified)
          if (!bytesRead) break
          copiedHash.update(buffer.subarray(0, bytesRead))
          verified += bytesRead
          options.onProgress?.({ phase: 'verifying', bytesProcessed: verified, totalBytes: sourceStat.size })
        }
      } finally {
        await verifyHandle.close()
      }
      const sourceSha256 = sourceHash.digest('hex')
      if (verified !== sourceStat.size || copiedHash.digest('hex') !== sourceSha256) {
        throw new Error('导入素材复制校验失败')
      }
      assertNotCanceled()
      await fs.promises.rename(stagingPath, destination)
      promoted = true
      const file = createFileEntry(destination)
      registerMaterialFile(file.path, {
        folderId,
        origin: 'user_upload',
        addedFrom: 'user_import',
        sourceSha256,
        sourceSize: sourceStat.size,
      })
      registered = true
      return describeKnownFile(file)
    } catch (error) {
      await Promise.allSettled([
        fs.promises.unlink(stagingPath),
        ...(promoted && !registered ? [fs.promises.unlink(destination)] : []),
      ])
      throw error
    }
  }

  function describeFile(
    file: FileEntry,
    folderId: string,
    origin: MaterialOrigin,
    addedFrom: MaterialAddedFrom,
  ): FileEntry {
    const identity = registerMaterialFile(file.path, { folderId, origin, addedFrom })
    return describeRegisteredFile(file, identity)
  }

  function describeRegisteredFile(file: FileEntry, identity: MaterialFileIdentity): FileEntry {
    const presentation = materialPresentationRows([identity.materialId], identity.folderId)
    return {
      ...file,
      materialId: identity.materialId,
      assetId: identity.assetId,
      assetVersion: identity.assetVersion,
      sourceSha256: identity.sourceSha256,
      localStatus: identity.localStatus,
      analysisStatus: identity.analysisStatus,
      analysisError: identity.analysisError,
      cloudAnalysisStatus: identity.cloudAnalysisStatus,
      cloudAnalysisError: identity.cloudAnalysisError,
      cloudStatus: identity.cloudStatus,
      cloudError: identity.cloudError,
      ...uploadTransferState(identity.materialId, identity.cloudStatus, presentation),
      ...analysisTransferState(identity.materialId, presentation),
    }
  }

  function describeKnownFile(file: FileEntry): FileEntry {
    const resolved = path.resolve(file.path)
    if (isInsideDirectory(resolved, path.join(materialsDir, 'cloud'))) {
      const known = getMaterialCloudFileByPath(resolved)
      return known ? describeRegisteredFile(file, known) : file
    }
    const isUserMaterial = isInsideDirectory(resolved, materialsDir)
    const isDownloadedMaterial = isInsideDirectory(resolved, runsDir)
    if (!isUserMaterial && !isDownloadedMaterial) return file
    const scope = isUserMaterial ? 'user' : 'downloads'
    const boundary = isUserMaterial ? materialsDir : runsDir
    const folderId = getOrCreateFolder({
      scope,
      storageKey: path.relative(boundary, path.dirname(resolved)),
      name: path.basename(path.dirname(resolved)),
    })
    return describeFile(
      file,
      folderId,
      isUserMaterial ? 'user_upload' : 'platform_download',
      isUserMaterial ? 'user_import' : 'task_download',
    )
  }

  function materialCloudFileFromRow(row: SqlRow): MaterialCloudFile {
    return {
      ...materialIdentityFromRow(row),
      displayName: stringValue(row.display_name),
      mimeType: stringValue(row.mime_type),
      sourceSize: numberValue(row.source_size),
      origin: stringValue(row.origin) as MaterialOrigin,
      addedFrom: stringValue(row.added_from) as MaterialAddedFrom,
      revision: numberValue(row.revision),
      cloudRevision: numberValue(row.cloud_revision),
      cloudAnalysisStatus: stringValue(row.cloud_analysis_status) as MaterialFileIdentity['analysisStatus'],
      cloudAnalysisError: stringValue(row.cloud_analysis_error) || undefined,
      publicationStatus: (stringValue(row.publication_status) || 'private') as MaterialPublicationStatus,
      publicationId: stringValue(row.publication_id) || undefined,
      publicationRevision: numberValue(row.publication_revision) || undefined,
      publicationReviewReason: stringValue(row.publication_review_reason) || undefined,
    }
  }

  function materialCloudFileQuery(whereClause: string, value: string): MaterialCloudFile | null {
    const row = database.prepare(`
      SELECT
        m.material_id, m.folder_id, m.local_folder_id, m.cloud_folder_id,
        m.asset_id, m.asset_version,
        m.display_name, m.added_from, m.revision, m.cloud_revision,
        m.publication_status, m.publication_id, m.publication_revision,
        m.publication_review_reason,
        f.local_file_id, f.relative_path, f.source_sha256, f.source_size, f.mtime, f.local_status,
        a.mime_type, a.origin, a.analysis_status, a.analysis_error,
        a.cloud_analysis_status, a.cloud_analysis_error,
        a.cloud_status, a.cloud_error
      FROM material m
      JOIN asset a ON a.asset_id = m.asset_id AND a.asset_version = m.asset_version
      JOIN local_material_file_map map ON map.material_id = m.material_id
      JOIN local_asset_file f ON f.local_file_id = map.local_file_id
      WHERE ${whereClause} AND m.deleted_at IS NULL
      LIMIT 1
    `).get(value) as SqlRow | undefined
    if (!row) return null
    reconcileLocalFileState(row)
    return materialCloudFileFromRow(row)
  }

  function getMaterialCloudFileByPath(filePath: string): MaterialCloudFile | null {
    let relativePath: string
    try {
      relativePath = relativePathFor(filePath)
    } catch {
      return null
    }
    return materialCloudFileQuery('f.relative_path = ?', relativePath)
  }

  function getMaterialCloudFileById(materialIdValue: unknown): MaterialCloudFile | null {
    const materialId = stringValue(materialIdValue).trim()
    if (!materialId) return null
    return materialCloudFileQuery('m.material_id = ?', materialId)
  }

  function getCloudDownloadSource(materialIdValue: unknown): MaterialCloudFile | null {
    const material = getMaterialCloudFileById(materialIdValue)
    if (!material || material.cloudRevision > 0) return material
    return materialCloudFileQuery(`m.cloud_revision > 0 AND (m.asset_id, m.asset_version) = (
      SELECT asset_id, asset_version FROM material WHERE material_id = ?
    )`, material.materialId)
  }

  function folderChainForMaterial(materialIdValue: unknown): CloudFolderRecord[] {
    const material = getMaterialCloudFileById(materialIdValue)
    if (!material) return []
    const chain: CloudFolderRecord[] = []
    const visited = new Set<string>()
    let folder = getFolder(material.folderId)
    while (folder && !visited.has(folder.folderId)) {
      visited.add(folder.folderId)
      if (folder.scope !== 'virtual') {
        const row = database.prepare(`
          SELECT revision FROM material_folder WHERE folder_id = ?
        `).get(folder.folderId) as SqlRow | undefined
        const parent = folder.parentFolderId ? getFolder(folder.parentFolderId) : null
        chain.push({
          folderId: folder.folderId,
          parentFolderId: parent && parent.scope !== 'virtual' ? parent.folderId : undefined,
          name: folder.name,
          revision: numberValue(row?.revision) || 1,
        })
      }
      folder = folder.parentFolderId ? getFolder(folder.parentFolderId) : null
    }
    return chain.reverse()
  }

  function listFolderFiles(folderIdValue: string): FileEntry[] {
    const folderId = folderIdValue.trim()
    if (!folderId) return []
    const folder = getFolder(folderId)
    if (!folder) return []
    const membershipWhere = folder.scope === 'user'
      ? '(m.local_folder_id = ? OR (m.local_folder_id IS NULL AND m.cloud_folder_id = ?))'
      : folder.scope === 'downloads'
        ? 'm.cloud_folder_id = ?'
        : 'm.folder_id = ?'
    const membershipParams = folder.scope === 'user' ? [folderId, folderId] : [folderId]
    const rows = database.prepare(`
      SELECT
        m.material_id, m.folder_id, m.local_folder_id, m.cloud_folder_id,
        m.asset_id, m.asset_version,
        m.display_name, m.added_from, m.revision, m.cloud_revision,
        m.publication_status, m.publication_id, m.publication_revision,
        m.publication_review_reason,
        f.local_file_id, f.relative_path, f.source_sha256, f.source_size, f.mtime, f.local_status,
        a.mime_type, a.origin, a.analysis_status, a.analysis_error,
        a.cloud_analysis_status, a.cloud_analysis_error,
        a.cloud_status, a.cloud_error
      FROM material m
      JOIN asset a ON a.asset_id = m.asset_id AND a.asset_version = m.asset_version
      JOIN local_material_file_map map ON map.material_id = m.material_id
      JOIN local_asset_file f ON f.local_file_id = map.local_file_id
      WHERE ${membershipWhere} AND m.deleted_at IS NULL
      ORDER BY m.updated_at DESC, m.material_id
    `).all(...membershipParams) as SqlRow[]
    return fileEntriesFromRows(rows)
  }

  function listCloudFiles(): FileEntry[] {
    const rows = database.prepare(`
      SELECT
        m.material_id, m.folder_id, m.local_folder_id, m.cloud_folder_id,
        m.asset_id, m.asset_version,
        m.display_name, m.added_from, m.revision, m.cloud_revision,
        m.publication_status, m.publication_id, m.publication_revision,
        m.publication_review_reason,
        f.local_file_id, f.relative_path, f.source_sha256, f.source_size, f.mtime, f.local_status,
        a.mime_type, a.origin, a.analysis_status, a.analysis_error,
        a.cloud_analysis_status, a.cloud_analysis_error,
        a.cloud_status, a.cloud_error
      FROM material m
      JOIN asset a ON a.asset_id = m.asset_id AND a.asset_version = m.asset_version
      JOIN local_material_file_map map ON map.material_id = m.material_id
      JOIN local_asset_file f ON f.local_file_id = map.local_file_id
      WHERE m.deleted_at IS NULL
        AND (
          m.cloud_folder_id IS NOT NULL
          OR m.cloud_revision > 0
          OR a.cloud_status IN ('uploading', 'verifying', 'ready', 'failed')
        )
      ORDER BY m.updated_at DESC, m.material_id
    `).all() as SqlRow[]
    return fileEntriesFromRows(rows)
  }

  function fileEntriesFromRows(rows: SqlRow[]): FileEntry[] {
    const presentation = materialPresentationRows(rows.map((row) => stringValue(row.material_id)))
    const snapshot = materialReadSnapshot
    return rows.map((row) => {
      const materialId = stringValue(row.material_id)
      const cached = snapshot?.files.get(materialId)
      if (cached && cached.rowSignature === JSON.stringify(row)) return cached.file
      const localStatus = reconcileLocalFileState(row)
      const identity = materialCloudFileFromRow(row)
      const filePath = identity.localPath
      const present = localStatus === 'present'
      const file = present
        ? createFileEntry(filePath)
        : {
            name: identity.displayName,
            path: filePath,
            url: '',
            size: identity.sourceSize,
            mtime: numberValue(row.mtime),
            ext: path.extname(identity.displayName).toLocaleLowerCase(),
          }
      const uploadState = uploadTransferState(identity.materialId, identity.cloudStatus, presentation)
      const downloadState = present ? {} : downloadTransferState(identity.materialId, presentation)
      const result: FileEntry = {
        ...file,
        materialId: identity.materialId,
        assetId: identity.assetId,
        assetVersion: identity.assetVersion,
        sourceSha256: identity.sourceSha256,
        localStatus,
        analysisStatus: identity.analysisStatus,
        analysisError: identity.analysisError,
        cloudAnalysisStatus: identity.cloudAnalysisStatus,
        cloudAnalysisError: identity.cloudAnalysisError,
        cloudStatus: identity.cloudStatus,
        cloudError: identity.cloudError,
        ...uploadState,
        ...downloadState,
        ...analysisTransferState(identity.materialId, presentation),
        publicationStatus: identity.publicationStatus,
        publicationId: identity.publicationId,
        publicationRevision: identity.publicationRevision,
        publicationReviewReason: identity.publicationReviewReason,
      }
      snapshot?.files.set(materialId, { rowSignature: JSON.stringify(row), file: result })
      return result
    })
  }

  function listCloudUploadCandidates(origins: MaterialOrigin[]): MaterialCloudFile[] {
    const allowed = origins.filter((origin, index) => origins.indexOf(origin) === index)
    if (!allowed.length) return []
    const placeholders = allowed.map(() => '?').join(',')
    const rows = database.prepare(`
      SELECT
        m.material_id, m.folder_id, m.local_folder_id, m.cloud_folder_id,
        m.asset_id, m.asset_version,
        m.display_name, m.added_from, m.revision, m.cloud_revision,
        m.publication_status, m.publication_id, m.publication_revision,
        m.publication_review_reason,
        f.relative_path, f.source_sha256, f.source_size, f.local_status,
        a.mime_type, a.origin, a.analysis_status, a.analysis_error,
        a.cloud_status, a.cloud_error
      FROM material m
      JOIN asset a ON a.asset_id = m.asset_id AND a.asset_version = m.asset_version
      JOIN local_material_file_map map ON map.material_id = m.material_id
      JOIN local_asset_file f ON f.local_file_id = map.local_file_id
      WHERE m.deleted_at IS NULL
        AND f.local_status = 'present'
        AND (a.cloud_status IN ('not_uploaded', 'failed')
          OR (a.cloud_status = 'ready' AND a.cloud_analysis_status <> 'ready'))
        AND a.origin IN (${placeholders})
      ORDER BY m.updated_at
    `).all(...allowed) as SqlRow[]
    return rows.map(materialCloudFileFromRow)
  }

  function setCloudStatusForMaterial(
    materialIdValue: unknown,
    status: MaterialFileIdentity['cloudStatus'],
    error = '',
  ): void {
    const material = getMaterialCloudFileById(materialIdValue)
    if (!material) throw new Error('素材不存在')
    const timestamp = now()
    database.prepare(`
      UPDATE asset
      SET cloud_status = ?, cloud_error = ?, updated_at = ?
      WHERE asset_id = ? AND asset_version = ?
    `).run(
      status,
      status === 'failed' ? error.trim() || null : null,
      timestamp,
      material.assetId,
      material.assetVersion,
    )
    if (status !== 'not_uploaded') {
      database.prepare(`
        UPDATE material
        SET cloud_folder_id = COALESCE(cloud_folder_id, local_folder_id, folder_id),
            updated_at = ?
        WHERE material_id = ? AND deleted_at IS NULL
      `).run(timestamp, material.materialId)
    }
  }

  function setCloudRevisionForFolder(folderIdValue: unknown, revisionValue: unknown): void {
    const folderId = stringValue(folderIdValue).trim()
    const revision = Math.max(1, Math.floor(numberValue(revisionValue)))
    const current = database.prepare(`
      SELECT revision FROM material_folder WHERE folder_id = ?
    `).get(folderId) as SqlRow | undefined
    database.prepare(`
      UPDATE material_folder
      SET cloud_revision = max(cloud_revision, ?), revision = max(revision, ?), updated_at = ?
      WHERE folder_id = ?
    `).run(revision, revision, now(), folderId)
    if (current && revision >= numberValue(current.revision)) resolveSyncConflict('folder', folderId)
  }

  function setCloudRevisionForMaterial(materialIdValue: unknown, revisionValue: unknown): void {
    const materialId = stringValue(materialIdValue).trim()
    const revision = Math.max(1, Math.floor(numberValue(revisionValue)))
    const current = database.prepare(`
      SELECT revision FROM material WHERE material_id = ?
    `).get(materialId) as SqlRow | undefined
    database.prepare(`
      UPDATE material
      SET cloud_folder_id = COALESCE(cloud_folder_id, local_folder_id, folder_id),
          cloud_revision = max(cloud_revision, ?), revision = max(revision, ?), updated_at = ?
      WHERE material_id = ?
    `).run(revision, revision, now(), materialId)
    if (current && revision >= numberValue(current.revision)) resolveSyncConflict('material', materialId)
  }

  function applyCloudDeletion(
    entityTypeValue: unknown,
    entityIdValue: unknown,
    revisionValue: unknown,
  ): void {
    const entityType = stringValue(entityTypeValue)
    const entityId = stringValue(entityIdValue).trim()
    const revision = Math.max(1, Math.floor(numberValue(revisionValue)))
    const timestamp = now()
    if (entityType === 'material') {
      database.prepare(`
        UPDATE material
        SET cloud_folder_id = NULL,
            deleted_at = CASE
              WHEN local_folder_id IS NOT NULL OR EXISTS (
                SELECT 1
                FROM local_material_file_map map
                JOIN local_asset_file file ON file.local_file_id = map.local_file_id
                WHERE map.material_id = material.material_id
                  AND file.local_status = 'present'
              ) THEN NULL ELSE ? END,
            cloud_revision = max(cloud_revision, ?),
            revision = max(revision, ?), updated_at = ?
        WHERE material_id = ? AND cloud_revision < ?
      `).run(timestamp, revision, revision, timestamp, entityId, revision)
      return
    }
    if (entityType === 'folder') {
      const folder = getFolder(entityId)
      if (!folder) return
      const tombstoneKey = `${folder.storageKey}#cloud-deleted:${entityId}`
      database.prepare(`
        UPDATE material_folder
        SET storage_key = ?, deleted_at = ?, cloud_revision = max(cloud_revision, ?),
            revision = max(revision, ?), updated_at = ?
        WHERE folder_id = ? AND cloud_revision < ?
      `).run(tombstoneKey, timestamp, revision, revision, timestamp, entityId, revision)
    }
  }

  function cloudFolderName(value: string): string {
    const name = value.trim()
    if (
      !name
      || name === '.'
      || name === '..'
      || /[<>:"/\\|?*]/.test(name)
      || name.endsWith('.')
      || name.endsWith(' ')
      || Array.from(name).some((character) => character.charCodeAt(0) <= 31)
    ) {
      throw new Error('云端文件夹名称不安全')
    }
    return name
  }

  function upsertCloudFolder(record: CloudFolderRecord): void {
    const folderId = record.folderId.trim()
    if (!folderId) throw new Error('云端文件夹缺少 folder_id')
    const existing = getFolder(folderId)
    const incomingRevision = Math.max(1, record.revision)
    if (existing && incomingRevision < existing.cloudRevision) return
    const name = cloudFolderName(record.name)
    const targetScope: MaterialFolderScope = existing?.scope === 'user' ? 'user' : 'downloads'
    const targetRootId = targetScope === 'user'
      ? getOrCreateFolder({
          scope: 'user',
          storageKey: '.',
          name: '本地素材',
        })
      : getOrCreateFolder({
          scope: 'virtual',
          storageKey: 'downloads-root',
          name: '云端素材',
        })
    const isTopLevelDownloadFolder = existing?.scope === 'downloads' && !record.parentFolderId
    let incomingParentId = record.parentFolderId || (isTopLevelDownloadFolder ? undefined : targetRootId)
    if (existing?.scope === 'user' && incomingParentId && getFolder(incomingParentId)?.scope === 'downloads') {
      const hierarchy = (id: string | undefined): string[] => {
        const names: string[] = []
        const visited = new Set<string>()
        let folder = id ? getFolder(id) : null
        while (folder && folder.scope !== 'virtual' && !visited.has(folder.folderId)) {
          visited.add(folder.folderId)
          names.unshift(folder.name)
          folder = folder.parentFolderId ? getFolder(folder.parentFolderId) : null
        }
        return names
      }
      const localNames = hierarchy(existing.parentFolderId)
      const cloudNames = hierarchy(incomingParentId)
      if (localNames.length === cloudNames.length && localNames.every((name, index) => (
        name.localeCompare(cloudNames[index], 'zh-CN', { sensitivity: 'base' }) === 0
      ))) incomingParentId = existing.parentFolderId
    }
    const parent = incomingParentId ? getFolder(incomingParentId) : null
    const validParent = parent && (
      parent.scope === targetScope
      || (targetScope === 'downloads' && parent.scope === 'virtual' && parent.folderId === targetRootId)
    )
    if (incomingParentId && !validParent) {
      throw new Error('云端文件夹父级不存在')
    }
    let storageKey = existing?.storageKey || (targetScope === 'user'
      ? normalizeStorageKey(path.join(parent?.storageKey || '.', name))
      : `.cloud-folders/${folderId}`)
    const occupied = database.prepare(`
      SELECT folder_id FROM material_folder
      WHERE scope = ? AND storage_key = ? AND deleted_at IS NULL AND folder_id <> ?
    `).get(targetScope, storageKey, folderId) as SqlRow | undefined
    if (occupied) {
      storageKey = targetScope === 'user'
        ? normalizeStorageKey(path.join(parent?.storageKey || '.', `${name}（云端-${folderId.slice(-6)}）`))
        : `.cloud-folders/${folderId}-${incomingRevision}`
    }
    if (targetScope === 'user') {
      const directory = path.resolve(materialsDir, storageKey === '.' ? '' : storageKey)
      if (!isInsideDirectory(directory, materialsDir)) throw new Error('云端文件夹超出托管目录')
      ensureDir(directory)
    }
    const timestamp = now()
    const hasPendingLocalChange = Boolean(existing && existing.revision > existing.cloudRevision)
    const metadataDiffers = Boolean(existing && (
      existing.name !== name || existing.parentFolderId !== incomingParentId
    ))
    const conflict = Boolean(
      existing
      && hasPendingLocalChange
      && incomingRevision > existing.cloudRevision
      && metadataDiffers
    )
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        INSERT INTO material_folder(
          folder_id, scope, storage_key, parent_folder_id, name,
          revision, cloud_revision, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(folder_id) DO UPDATE SET
          storage_key = CASE
            WHEN material_folder.revision > material_folder.cloud_revision
              THEN material_folder.storage_key ELSE excluded.storage_key END,
          parent_folder_id = CASE
            WHEN material_folder.revision > material_folder.cloud_revision
              THEN material_folder.parent_folder_id ELSE excluded.parent_folder_id END,
          name = CASE
            WHEN material_folder.revision > material_folder.cloud_revision
              THEN material_folder.name ELSE excluded.name END,
          revision = max(material_folder.revision, excluded.cloud_revision),
          cloud_revision = max(material_folder.cloud_revision, excluded.cloud_revision),
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        folderId,
        targetScope,
        storageKey,
        incomingParentId || null,
        name,
        incomingRevision,
        incomingRevision,
        timestamp,
        timestamp,
      )
      if (conflict && existing) {
        database.prepare(`
          UPDATE material_folder
          SET revision = max(revision, ?) + 1, updated_at = ?
          WHERE folder_id = ?
        `).run(incomingRevision, timestamp, folderId)
        recordSyncConflict(
          'folder',
          folderId,
          existing.revision,
          existing.cloudRevision,
          incomingRevision,
          { parentFolderId: incomingParentId, name },
        )
        queueCloudOperation('sync_folder', folderId, { conflict: true })
      } else if (existing && incomingRevision >= existing.revision) {
        resolveSyncConflict('folder', folderId)
      }
      database.exec('COMMIT')
    } catch (operationError) {
      database.exec('ROLLBACK')
      throw operationError
    }
  }

  function cloudRelativePath(record: CloudMaterialRecord): string {
    const extension = path.extname(record.displayName).toLocaleLowerCase()
    const safeExtension = VIDEO_EXTENSIONS.includes(extension) ? extension : '.mp4'
    const baseName = path.basename(record.displayName, path.extname(record.displayName))
      // eslint-disable-next-line no-control-regex -- Windows file names cannot contain ASCII control characters.
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '') || 'cloud-material'
    return normalizeStorageKey(path.join(
      path.relative(dataRoot, materialsDir),
      'cloud',
      record.assetId,
      String(record.assetVersion),
      `${baseName}${safeExtension}`,
    ))
  }

  function upsertCloudMaterial(record: CloudMaterialRecord): void {
    const folder = getFolder(record.folderId)
    if (!folder) throw new Error(`云端素材文件夹不存在：${record.folderId}`)
    const existingMaterial = database.prepare(`
      SELECT folder_id, local_folder_id, cloud_folder_id, display_name, revision, cloud_revision
      FROM material WHERE material_id = ?
    `).get(record.materialId) as SqlRow | undefined
    const incomingRevision = Math.max(1, record.revision)
    const existingRevision = numberValue(existingMaterial?.revision)
    const existingCloudRevision = numberValue(existingMaterial?.cloud_revision)
    const conflict = Boolean(
      existingMaterial
      && existingRevision > existingCloudRevision
      && incomingRevision > existingCloudRevision
      && (
        stringValue(existingMaterial.cloud_folder_id || existingMaterial.folder_id) !== record.folderId
        || stringValue(existingMaterial.display_name) !== record.displayName
      )
    )
    const existingAsset = database.prepare(`
      SELECT source_sha256, source_size
      FROM asset WHERE asset_id = ? AND asset_version = ?
    `).get(record.assetId, record.assetVersion) as SqlRow | undefined
    if (existingAsset && (
      stringValue(existingAsset.source_sha256) !== record.sourceSha256
      || numberValue(existingAsset.source_size) !== record.sourceSize
    )) {
      throw new Error('云端素材身份与本地内容指纹冲突')
    }
    const timestamp = now()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        INSERT INTO asset(
          asset_id, asset_version, source_sha256, source_size, mime_type,
          original_file_name, origin, analysis_status, analysis_error,
          cloud_analysis_status, cloud_analysis_error,
          cloud_status, cloud_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, asset_version) DO UPDATE SET
          cloud_analysis_status = excluded.cloud_analysis_status,
          cloud_analysis_error = excluded.cloud_analysis_error,
          cloud_status = excluded.cloud_status,
          cloud_error = excluded.cloud_error,
          updated_at = excluded.updated_at
      `).run(
        record.assetId,
        record.assetVersion,
        record.sourceSha256,
        record.sourceSize,
        record.mimeType,
        record.displayName,
        record.origin,
        record.analysisStatus,
        record.analysisError || null,
        record.cloudStatus,
        record.cloudError || null,
        timestamp,
        timestamp,
      )
      database.prepare(`
        INSERT INTO material(
          material_id, folder_id, local_folder_id, cloud_folder_id,
          asset_id, asset_version, display_name,
          added_from, revision, cloud_revision, publication_status,
          publication_id, publication_revision, publication_review_reason,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(material_id) DO UPDATE SET
          folder_id = CASE
            WHEN material.local_folder_id IS NOT NULL
              THEN material.folder_id
            WHEN material.revision > material.cloud_revision
              OR excluded.cloud_revision < material.cloud_revision
              THEN material.folder_id ELSE excluded.folder_id END,
          cloud_folder_id = CASE
            WHEN excluded.cloud_revision < material.cloud_revision
              THEN material.cloud_folder_id ELSE excluded.cloud_folder_id END,
          display_name = CASE
            WHEN material.revision > material.cloud_revision
              OR excluded.cloud_revision < material.cloud_revision
              THEN material.display_name ELSE excluded.display_name END,
          revision = max(material.revision, excluded.cloud_revision),
          cloud_revision = max(material.cloud_revision, excluded.cloud_revision),
          publication_status = excluded.publication_status,
          publication_id = excluded.publication_id,
          publication_revision = excluded.publication_revision,
          publication_review_reason = excluded.publication_review_reason,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        record.materialId,
        record.folderId,
        record.folderId,
        record.assetId,
        record.assetVersion,
        record.displayName,
        record.addedFrom,
        record.revision,
        record.publicationStatus || 'private',
        record.publicationId || null,
        record.publicationRevision || null,
        record.publicationReviewReason || null,
        timestamp,
        timestamp,
      )
      if (conflict && existingMaterial) {
        database.prepare(`
          UPDATE material
          SET revision = max(revision, ?) + 1, updated_at = ?
          WHERE material_id = ?
        `).run(incomingRevision, timestamp, record.materialId)
        recordSyncConflict(
          'material',
          record.materialId,
          existingRevision,
          existingCloudRevision,
          incomingRevision,
          { folderId: record.folderId, displayName: record.displayName },
        )
        queueCloudOperation('sync_material', record.materialId, { conflict: true })
      } else if (existingMaterial && incomingRevision >= existingRevision) {
        resolveSyncConflict('material', record.materialId)
      }
      const mapped = database.prepare(`
        SELECT local_file_id FROM local_material_file_map WHERE material_id = ?
      `).get(record.materialId) as SqlRow | undefined
      if (!mapped) {
        const relativePath = cloudRelativePath(record)
        // Multiple cloud material records can refer to the same asset/version.
        // Reuse its local file mapping instead of inserting the same path twice.
        const sharedFile = database.prepare(`
          SELECT local_file_id FROM local_asset_file
          WHERE relative_path = ? AND asset_id = ? AND asset_version = ?
            AND source_sha256 = ? AND source_size = ?
        `).get(relativePath, record.assetId, record.assetVersion, record.sourceSha256, record.sourceSize) as SqlRow | undefined
        const localFileId = stringValue(sharedFile?.local_file_id) || `file_${randomUUID().replaceAll('-', '')}`
        if (!sharedFile) database.prepare(`
          INSERT INTO local_asset_file(
            local_file_id, asset_id, asset_version, relative_path, source_sha256,
            source_size, mtime, local_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 'missing', ?, ?)
        `).run(
          localFileId,
          record.assetId,
          record.assetVersion,
          relativePath,
          record.sourceSha256,
          record.sourceSize,
          timestamp,
          timestamp,
        )
        database.prepare(`
          INSERT INTO local_material_file_map(material_id, local_file_id) VALUES (?, ?)
        `).run(record.materialId, localFileId)
      }
      if (record.cloudStatus === 'ready') {
        database.prepare(`
          UPDATE local_transfer_session
          SET status = 'ready', bytes_transferred = total_bytes,
              last_error = NULL, updated_at = ?
          WHERE material_id = ? AND direction = 'upload'
            AND status <> 'ready'
        `).run(timestamp, record.materialId)
      } else if (record.cloudStatus === 'failed') {
        database.prepare(`
          UPDATE local_transfer_session
          SET status = 'failed', last_error = ?, updated_at = ?
          WHERE material_id = ? AND direction = 'upload'
            AND status IN ('queued', 'uploading', 'verifying')
        `).run(record.cloudError || '云端校验失败', timestamp, record.materialId)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function completeCloudDownload(
    materialIdValue: unknown,
    filePath: string,
    sourceSha256: string,
    sourceSize: number,
  ): void {
    const material = getMaterialCloudFileById(materialIdValue)
    if (!material) throw new Error('素材不存在')
    if (material.sourceSha256 !== sourceSha256 || material.sourceSize !== sourceSize) {
      throw new Error('下载素材校验结果与素材身份不一致')
    }
    const resolved = path.resolve(filePath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size !== sourceSize) throw new Error('下载素材文件大小不一致')
    const relativePath = relativePathFor(resolved)
    const timestamp = now()
    database.prepare(`
      UPDATE local_asset_file
      SET relative_path = ?, source_sha256 = ?, source_size = ?, mtime = ?,
          local_status = 'present', updated_at = ?
      WHERE local_file_id = (
        SELECT local_file_id FROM local_material_file_map WHERE material_id = ?
      )
    `).run(relativePath, sourceSha256, sourceSize, stat.mtimeMs, timestamp, material.materialId)
  }

  function queueCloudOperation(
    operationType: MaterialCloudOperationType,
    entityIdValue: unknown,
    payload: Record<string, unknown> = {},
  ): MaterialCloudOperation {
    const entityId = stringValue(entityIdValue).trim()
    if (!entityId) throw new Error('云端操作缺少资源 ID')
    const analysisTransfer = ['sync_analysis', 'restore_analysis'].includes(operationType)
    const activeStatuses = operationType === 'upload'
      ? "'queued', 'processing', 'paused', 'failed', 'canceled'"
      : analysisTransfer ? "'queued', 'processing', 'failed'" : "'queued'"
    const existing = database.prepare(`
      SELECT * FROM local_sync_outbox
      WHERE operation_type = ? AND entity_id = ? AND status IN (${activeStatuses})
      ORDER BY
        CASE status WHEN 'queued' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 1
    `).get(operationType, entityId) as SqlRow | undefined
    if (existing && !(operationType === 'upload'
      && stringValue(existing.status) === 'canceled' && payload.explicitResume === true)) {
      const existingStatus = stringValue(existing.status)
      if (operationType === 'upload' && ['paused', 'canceled'].includes(existingStatus)) {
        // Discovery and startup recovery must not undo an explicit user decision.
        if (payload.explicitResume !== true) return cloudOperationFromRow(existing)
      }
      if (operationType === 'upload' && ['paused', 'failed'].includes(existingStatus)) {
        resumeCloudUpload(entityId)
      }
      if (analysisTransfer && existingStatus === 'failed') {
        database.prepare(`
          UPDATE local_sync_outbox SET status='queued', attempt_count=0, last_error=NULL,
            next_retry_at=?, updated_at=? WHERE operation_id=? AND status='failed'
        `).run(now(), now(), stringValue(existing.operation_id))
      }
      database.prepare(`
        UPDATE local_sync_outbox
        SET payload_json = ?, next_retry_at = ?, last_error = NULL, updated_at = ?
        WHERE operation_id = ? AND status = 'queued'
      `).run(JSON.stringify(payload), now(), now(), stringValue(existing.operation_id))
      const updated = database.prepare(`
        SELECT * FROM local_sync_outbox
        WHERE operation_type = ? AND entity_id = ?
          AND status IN ('queued', 'processing')
        ORDER BY updated_at DESC LIMIT 1
      `).get(operationType, entityId) as SqlRow | undefined
      if (!updated) throw new Error('云端上传队列恢复失败')
      return cloudOperationFromRow(updated)
    }
    const operationId = `op_${randomUUID().replaceAll('-', '')}`
    const timestamp = now()
    database.prepare(`
      INSERT INTO local_sync_outbox(
        operation_id, operation_type, entity_id, payload_json, status,
        attempt_count, next_retry_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 0, ?, NULL, ?, ?)
    `).run(
      operationId,
      operationType,
      entityId,
      JSON.stringify(payload),
      timestamp,
      timestamp,
      timestamp,
    )
    const stored = database.prepare('SELECT * FROM local_sync_outbox WHERE operation_id = ?')
      .get(operationId) as SqlRow
    return cloudOperationFromRow(stored)
  }

  function cloudOperationFromRow(row: SqlRow): MaterialCloudOperation {
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(stringValue(row.payload_json))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed
    } catch {
      payload = {}
    }
    return {
      operationId: stringValue(row.operation_id),
      operationType: stringValue(row.operation_type) as MaterialCloudOperationType,
      entityId: stringValue(row.entity_id),
      payload,
      status: stringValue(row.status) as MaterialCloudOperationStatus,
      attemptCount: numberValue(row.attempt_count),
      nextRetryAt: stringValue(row.next_retry_at),
      lastError: stringValue(row.last_error) || undefined,
    }
  }

  function claimCloudOperations(limitValue = 4): MaterialCloudOperation[] {
    const limit = Math.max(1, Math.min(20, Math.floor(limitValue)))
    const timestamp = now()
    const rows = database.prepare(`
      SELECT * FROM local_sync_outbox outbox
      WHERE status = 'queued' AND next_retry_at <= ?
        AND (operation_type NOT IN ('upload', 'sync_analysis') OR EXISTS (
          SELECT 1 FROM material m
          JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
          WHERE m.material_id=outbox.entity_id AND m.deleted_at IS NULL
            AND a.analysis_status='ready'
        ))
      ORDER BY created_at, operation_id
      LIMIT ?
    `).all(timestamp, limit) as SqlRow[]
    if (!rows.length) return []
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        database.prepare(`
          UPDATE local_sync_outbox
          SET status = 'processing', updated_at = ?
          WHERE operation_id = ? AND status = 'queued'
        `).run(timestamp, stringValue(row.operation_id))
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return rows.map((row) => cloudOperationFromRow({ ...row, status: 'processing' }))
  }

  function completeCloudOperation(operationIdValue: unknown): void {
    const operationId = stringValue(operationIdValue).trim()
    database.prepare(`
      UPDATE local_sync_outbox
      SET status = 'succeeded', last_error = NULL, updated_at = ?
      WHERE operation_id = ? AND status = 'processing'
    `).run(now(), operationId)
  }

  function releaseCloudOperation(operationIdValue: unknown): void {
    const operationId = stringValue(operationIdValue).trim()
    const timestamp = now()
    // Session changes are cancellation, not network failures. Leave completed,
    // explicitly paused and canceled operations untouched, including late calls.
    database.prepare(`
      UPDATE local_sync_outbox
      SET status = 'queued', next_retry_at = ?, last_error = NULL, updated_at = ?
      WHERE operation_id = ? AND status IN ('processing', 'failed')
    `).run(timestamp, timestamp, operationId)
  }

  function retryCloudOperation(
    operationIdValue: unknown,
    errorValue: unknown,
    retryAt: string,
  ): void {
    const operationId = stringValue(operationIdValue).trim()
    const error = stringValue(errorValue).trim().slice(0, 1000)
    const row = database.prepare(`
      SELECT attempt_count FROM local_sync_outbox
      WHERE operation_id = ? AND status = 'processing'
    `).get(operationId) as SqlRow | undefined
    if (!row) return
    const attempts = numberValue(row?.attempt_count) + 1
    database.prepare(`
      UPDATE local_sync_outbox
      SET status = ?, attempt_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'processing'
    `).run(attempts >= 8 ? 'failed' : 'queued', attempts, retryAt, error || null, now(), operationId)
  }

  function cloudOperationCounts(): { pending: number; failed: number } {
    const rows = database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM local_sync_outbox
      WHERE status IN ('queued', 'processing', 'paused', 'failed')
      GROUP BY status
    `).all() as SqlRow[]
    let pending = 0
    let failed = 0
    for (const row of rows) {
      const count = numberValue(row.count)
      if (stringValue(row.status) === 'failed') failed += count
      else pending += count
    }
    return { pending, failed }
  }

  function saveTransferSession(session: MaterialTransferSession): void {
    const timestamp = now()
    database.prepare(`
      INSERT INTO local_transfer_session(
        session_id, direction, material_id, status, bytes_transferred,
        total_bytes, part_size, completed_parts_json, temp_relative_path,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        bytes_transferred = excluded.bytes_transferred,
        total_bytes = excluded.total_bytes,
        part_size = excluded.part_size,
        completed_parts_json = excluded.completed_parts_json,
        temp_relative_path = excluded.temp_relative_path,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      session.sessionId,
      session.direction,
      session.materialId,
      session.status,
      session.bytesTransferred,
      session.totalBytes,
      session.partSize,
      JSON.stringify(session.completedParts),
      session.tempRelativePath || null,
      session.lastError || null,
      timestamp,
      timestamp,
    )
  }

  function getTransferSession(
    materialIdValue: unknown,
    direction: MaterialTransferSession['direction'],
  ): MaterialTransferSession | null {
    const row = database.prepare(`
      SELECT * FROM local_transfer_session
      WHERE material_id = ? AND direction = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(stringValue(materialIdValue).trim(), direction) as SqlRow | undefined
    if (!row) return null
    let completedParts: number[] = []
    try {
      const parsed = JSON.parse(stringValue(row.completed_parts_json))
      if (Array.isArray(parsed)) completedParts = parsed.map(Number).filter(Number.isFinite)
    } catch {
      completedParts = []
    }
    return {
      sessionId: stringValue(row.session_id),
      direction: stringValue(row.direction) as MaterialTransferSession['direction'],
      materialId: stringValue(row.material_id),
      status: stringValue(row.status),
      bytesTransferred: numberValue(row.bytes_transferred),
      totalBytes: numberValue(row.total_bytes),
      partSize: numberValue(row.part_size),
      completedParts,
      tempRelativePath: stringValue(row.temp_relative_path) || undefined,
      lastError: stringValue(row.last_error) || undefined,
    }
  }

  function materialPresentationRows(materialIds: string[], prefetchFolderId?: string): MaterialPresentationRows {
    const empty: MaterialPresentationRows = {
      uploads: new Map(), analyses: new Map(), transfers: new Map(),
    }
    const ids = [...new Set(materialIds.filter(Boolean))]
    if (!ids.length) return empty
    const snapshot = materialReadSnapshot
    if (snapshot) {
      const revision = getMaterialReadRevision()
      if (snapshot.revision !== revision) {
        snapshot.presentation = undefined
        snapshot.presentationIds.clear()
        snapshot.presentationFolders.clear()
        snapshot.allPresentationLoaded = false
        snapshot.files.clear()
        snapshot.revision = revision
      }
      if (snapshot.allPresentationLoaded && snapshot.presentation) return snapshot.presentation
    }
    const result = snapshot?.presentation || empty
    let missingIds = snapshot ? ids.filter((id) => !snapshot.presentationIds.has(id)) : ids
    if (!missingIds.length) return result
    // Filesystem browsing describes one file at a time. Prefetch only the
    // registered members of that direct folder so a small local directory
    // neither issues three queries per file nor loads unrelated history.
    if (snapshot && prefetchFolderId && !snapshot.presentationFolders.has(prefetchFolderId)) {
      const folderRows = database.prepare(`
        SELECT material_id FROM material
        WHERE deleted_at IS NULL AND (folder_id=? OR local_folder_id=? OR cloud_folder_id=?)
      `).all(prefetchFolderId, prefetchFolderId, prefetchFolderId) as SqlRow[]
      missingIds = [...new Set([...missingIds, ...folderRows.map(row => stringValue(row.material_id))])]
        .filter(id => id && !snapshot.presentationIds.has(id))
      snapshot.presentationFolders.add(prefetchFolderId)
    }
    // A small directory only loads its own status rows. Switch to one full map
    // when the same synchronous read actually expands a large collection.
    const loadAll = Boolean(snapshot && (missingIds.length >= 500
      || snapshot.presentationIds.size + missingIds.length >= 500))
    const batches: Array<string[] | null> = loadAll
      ? [null] : Array.from({ length: Math.ceil(missingIds.length / 500) }, (_, index) => missingIds.slice(index * 500, (index + 1) * 500))
    for (const batch of batches) {
      const placeholders = batch?.map(() => '?').join(',')
      const entityFilter = batch ? `AND entity_id IN (${placeholders})` : ''
      const materialFilter = batch ? `WHERE material_id IN (${placeholders})` : ''
      const uploads = database.prepare(`
        SELECT entity_id, status FROM (
          SELECT entity_id, status,
            row_number() OVER (PARTITION BY entity_id ORDER BY updated_at DESC, operation_id DESC) AS rank
          FROM local_sync_outbox WHERE operation_type='upload' ${entityFilter}
        ) WHERE rank=1
      `).all(...(batch || [])) as SqlRow[]
      const analyses = database.prepare(`
        SELECT entity_id, operation_type, status, last_error FROM (
          SELECT entity_id, operation_type, status, last_error,
            row_number() OVER (PARTITION BY entity_id ORDER BY updated_at DESC, created_at DESC, rowid DESC) AS rank
          FROM local_sync_outbox
          WHERE operation_type IN ('sync_analysis','restore_analysis')
            AND status IN ('queued','processing','failed','succeeded') ${entityFilter}
        ) WHERE rank=1
      `).all(...(batch || [])) as SqlRow[]
      const transfers = database.prepare(`
        SELECT material_id, direction, status, bytes_transferred, total_bytes FROM (
          SELECT material_id, direction, status, bytes_transferred, total_bytes,
            row_number() OVER (PARTITION BY material_id,direction ORDER BY updated_at DESC) AS rank
          FROM local_transfer_session ${materialFilter}
        ) WHERE rank=1
      `).all(...(batch || [])) as SqlRow[]
      for (const row of uploads) result.uploads.set(stringValue(row.entity_id), row)
      for (const row of analyses) result.analyses.set(stringValue(row.entity_id), row)
      for (const row of transfers) result.transfers.set(`${stringValue(row.direction)}:${stringValue(row.material_id)}`, row)
    }
    if (snapshot) {
      snapshot.presentation = result
      for (const id of missingIds) snapshot.presentationIds.add(id)
      snapshot.allPresentationLoaded = loadAll
    }
    return result
  }

  function uploadTransferState(
    materialId: string,
    cloudStatus: MaterialFileIdentity['cloudStatus'],
    presentation: MaterialPresentationRows,
  ): Pick<
    FileEntry,
    'uploadTransferStatus' | 'uploadBytesTransferred' | 'uploadTotalBytes'
  > {
    if (!materialId) return {}
    const operation = presentation.uploads.get(materialId)
    const transfer = presentation.transfers.get(`upload:${materialId}`)
    const operationStatus = stringValue(operation?.status)
    const status = cloudStatus === 'ready'
      ? 'ready'
      : operationStatus === 'queued'
      ? 'queued'
      : operationStatus === 'processing'
        ? transfer?.status === 'verifying' ? 'verifying' : 'uploading'
        : ['paused', 'failed', 'canceled'].includes(operationStatus)
          ? operationStatus
          : stringValue(transfer?.status)
    const allowed = ['queued', 'uploading', 'paused', 'verifying', 'failed', 'canceled', 'ready']
    if (!allowed.includes(status || '')) return {}
    return {
      uploadTransferStatus: status as FileEntry['uploadTransferStatus'],
      uploadBytesTransferred: transfer ? numberValue(transfer.bytes_transferred) : undefined,
      uploadTotalBytes: transfer ? numberValue(transfer.total_bytes) : undefined,
    }
  }

  function analysisTransferState(materialId: string, presentation: MaterialPresentationRows): Pick<FileEntry,
    'analysisTransferStatus' | 'analysisTransferDirection' | 'analysisTransferError'> {
    const row = presentation.analyses.get(materialId)
    if (!row) return {}
    return {
      analysisTransferDirection: row.operation_type === 'restore_analysis' ? 'download' : 'upload',
      analysisTransferStatus: row.status === 'succeeded' ? 'ready'
        : row.status as FileEntry['analysisTransferStatus'],
      analysisTransferError: stringValue(row.last_error) || undefined,
    }
  }

  function markCloudAnalysisReady(expected: MaterialCloudFile): void {
    const current = getMaterialCloudFileById(expected.materialId)
    if (!current || current.assetId !== expected.assetId || current.assetVersion !== expected.assetVersion
      || current.sourceSha256 !== expected.sourceSha256 || current.sourceSize !== expected.sourceSize) {
      throw new Error('素材身份已变化，不能应用旧的云端分析结果')
    }
    database.prepare(`
      UPDATE asset SET cloud_analysis_status='ready', cloud_analysis_error=NULL, updated_at=?
      WHERE asset_id=? AND asset_version=? AND source_sha256=? AND source_size=?
    `).run(now(), expected.assetId, expected.assetVersion, expected.sourceSha256, expected.sourceSize)
  }

  function downloadTransferState(materialId: string, presentation: MaterialPresentationRows): Pick<
    FileEntry,
    'downloadTransferStatus' | 'downloadBytesTransferred' | 'downloadTotalBytes'
  > {
    const transfer = presentation.transfers.get(`download:${materialId}`)
    if (!transfer || !['downloading', 'verifying', 'failed', 'ready'].includes(stringValue(transfer.status))) return {}
    return {
      downloadTransferStatus: transfer.status as FileEntry['downloadTransferStatus'],
      downloadBytesTransferred: numberValue(transfer.bytes_transferred),
      downloadTotalBytes: numberValue(transfer.total_bytes),
    }
  }

  function pauseCloudUpload(materialIdValue: unknown): boolean {
    const materialId = stringValue(materialIdValue).trim()
    if (!materialId) return false
    const timestamp = now()
    const operation = database.prepare(`
      UPDATE local_sync_outbox
      SET status = 'paused', last_error = NULL, updated_at = ?
      WHERE operation_type = 'upload' AND entity_id = ?
        AND status IN ('queued', 'processing', 'failed')
    `).run(timestamp, materialId)
    database.prepare(`
      UPDATE local_transfer_session
      SET status = 'paused', last_error = NULL, updated_at = ?
      WHERE material_id = ? AND direction = 'upload'
        AND status IN ('queued', 'uploading', 'failed')
    `).run(timestamp, materialId)
    return numberValue(operation.changes) > 0
  }

  function resumeCloudUpload(materialIdValue: unknown): boolean {
    const materialId = stringValue(materialIdValue).trim()
    if (!materialId) return false
    const active = database.prepare(`
      SELECT operation_id FROM local_sync_outbox
      WHERE operation_type = 'upload' AND entity_id = ?
        AND status IN ('queued', 'processing')
      ORDER BY updated_at DESC LIMIT 1
    `).get(materialId) as SqlRow | undefined
    if (active) return true
    const resumable = database.prepare(`
      SELECT operation_id FROM local_sync_outbox
      WHERE operation_type = 'upload' AND entity_id = ?
        AND status IN ('paused', 'failed')
      ORDER BY updated_at DESC, operation_id DESC LIMIT 1
    `).get(materialId) as SqlRow | undefined
    if (!resumable) return false
    const operationId = stringValue(resumable.operation_id)
    const timestamp = now()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        UPDATE local_sync_outbox
        SET status = 'canceled', updated_at = ?
        WHERE operation_type = 'upload' AND entity_id = ?
          AND status IN ('paused', 'failed') AND operation_id <> ?
      `).run(timestamp, materialId, operationId)
      database.prepare(`
        UPDATE local_sync_outbox
        SET status = 'queued', attempt_count = 0, next_retry_at = ?,
            last_error = NULL, updated_at = ?
        WHERE operation_id = ? AND status IN ('paused', 'failed')
      `).run(timestamp, timestamp, operationId)
      database.prepare(`
        UPDATE local_transfer_session
        SET status = 'queued', last_error = NULL, updated_at = ?
        WHERE material_id = ? AND direction = 'upload'
          AND status IN ('paused', 'failed')
      `).run(timestamp, materialId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return true
  }

  function cancelCloudUpload(materialIdValue: unknown): boolean {
    const materialId = stringValue(materialIdValue).trim()
    if (!materialId) return false
    const timestamp = now()
    const operation = database.prepare(`
      UPDATE local_sync_outbox
      SET status = 'canceled', last_error = NULL, updated_at = ?
      WHERE operation_type = 'upload' AND entity_id = ?
        AND status IN ('queued', 'processing', 'paused', 'failed')
    `).run(timestamp, materialId)
    const transfer = database.prepare(`
      UPDATE local_transfer_session
      SET status = 'canceled', last_error = NULL, updated_at = ?
      WHERE material_id = ? AND direction = 'upload'
        AND status IN ('queued', 'uploading', 'paused', 'failed')
    `).run(timestamp, materialId)
    return numberValue(operation.changes) > 0 || numberValue(transfer.changes) > 0
  }

  function getCloudState(keyValue: unknown): string {
    const row = database.prepare(`
      SELECT state_value FROM local_cloud_state WHERE state_key = ?
    `).get(stringValue(keyValue).trim()) as SqlRow | undefined
    return stringValue(row?.state_value)
  }

  function setCloudState(keyValue: unknown, value: unknown): void {
    const key = stringValue(keyValue).trim()
    if (!key) throw new Error('云端状态键不能为空')
    database.prepare(`
      INSERT INTO local_cloud_state(state_key, state_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET
        state_value = excluded.state_value,
        updated_at = excluded.updated_at
    `).run(key, stringValue(value), now())
  }

  function folderIdsAtOrBelow(folder: MaterialFolderIdentity): string[] {
    const prefix = normalizeStorageKey(folder.storageKey)
    const descendantPattern = `${prefix.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}/%`
    const rows = database.prepare(`
      WITH RECURSIVE subtree(folder_id) AS (
        SELECT folder_id FROM material_folder WHERE folder_id = ? AND deleted_at IS NULL
        UNION
        SELECT child.folder_id
        FROM material_folder child
        JOIN subtree parent ON child.parent_folder_id = parent.folder_id
        WHERE child.deleted_at IS NULL
      )
      SELECT folder_id
      FROM material_folder
      WHERE deleted_at IS NULL
        AND (
          folder_id IN (SELECT folder_id FROM subtree)
          OR (scope = ? AND (storage_key = ? OR storage_key LIKE ? ESCAPE '!'))
        )
    `).all(folder.folderId, folder.scope, prefix, descendantPattern) as SqlRow[]
    return [...new Set(rows.map((row) => stringValue(row.folder_id)).filter(Boolean))]
  }

  function localMaterialIdsForFolder(folderId: string, includeSubfolders: boolean): string[] {
    const folder = getFolder(folderId)
    if (!folder) throw new Error(`素材文件夹不存在：${folderId}`)
    if (folder.scope === 'virtual' && folder.storageKey === 'downloads-root') {
      return (database.prepare(`
        SELECT DISTINCT m.material_id
        FROM material m
        JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
        WHERE m.deleted_at IS NULL
          AND (
            m.cloud_folder_id IS NOT NULL
            OR m.cloud_revision > 0
            OR a.cloud_status IN ('uploading', 'verifying', 'ready', 'failed')
          )
        ORDER BY m.material_id
      `).all() as SqlRow[]).map((row) => stringValue(row.material_id))
    }
    const aggregateLocalRoot = folder.scope === 'user' && folder.storageKey === '.'
    const folderIds = includeSubfolders || aggregateLocalRoot
      ? folderIdsAtOrBelow(folder)
      : [folderId]
    const placeholders = folderIds.map(() => '?').join(',')
    if (!placeholders) return []
    const membershipWhere = folder.scope === 'user'
      ? `local_folder_id IN (${placeholders})`
      : folder.scope === 'downloads'
        ? `(cloud_folder_id IN (${placeholders}) OR (cloud_folder_id IS NULL AND local_folder_id IN (${placeholders})))`
        : `folder_id IN (${placeholders})`
    const membershipParams = folder.scope === 'downloads' ? [...folderIds, ...folderIds] : folderIds
    return (database.prepare(`
      SELECT material_id FROM material
      WHERE ${membershipWhere} AND deleted_at IS NULL
      ORDER BY material_id
    `).all(...membershipParams) as SqlRow[]).map((row) => stringValue(row.material_id))
  }

  function getDeletionImpact(
    materialIdValues: string[],
    folderIdValues: string[],
  ): MaterialDeletionImpact {
    const materialIds = new Set(materialIdValues.map((value) => stringValue(value).trim()).filter(Boolean))
    const folderIds = new Set<string>()
    for (const folderIdValue of folderIdValues) {
      const folder = getFolder(folderIdValue)
      if (!folder) continue
      for (const folderId of folderIdsAtOrBelow(folder)) folderIds.add(folderId)
    }
    if (folderIds.size) {
      const placeholders = [...folderIds].map(() => '?').join(',')
      const rows = database.prepare(`
        SELECT material_id FROM material
        WHERE (
          folder_id IN (${placeholders})
          OR local_folder_id IN (${placeholders})
          OR cloud_folder_id IN (${placeholders})
        ) AND deleted_at IS NULL
      `).all(...folderIds, ...folderIds, ...folderIds) as SqlRow[]
      for (const row of rows) materialIds.add(stringValue(row.material_id))
    }

    let localFileCount = 0
    let cloudCopyCount = 0
    let publicMaterialCount = 0
    if (materialIds.size) {
      const placeholders = [...materialIds].map(() => '?').join(',')
      const row = database.prepare(`
        SELECT
          sum(CASE WHEN f.local_status = 'present' THEN 1 ELSE 0 END) AS local_file_count,
          sum(CASE WHEN m.cloud_revision > 0 OR a.cloud_status <> 'not_uploaded' THEN 1 ELSE 0 END) AS cloud_copy_count,
          sum(CASE WHEN m.publication_status IN ('publishing', 'public', 'suspended') THEN 1 ELSE 0 END) AS public_material_count
        FROM material m
        JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
        JOIN local_material_file_map map ON map.material_id=m.material_id
        JOIN local_asset_file f ON f.local_file_id=map.local_file_id
        WHERE m.material_id IN (${placeholders}) AND m.deleted_at IS NULL
      `).get(...materialIds) as SqlRow | undefined
      localFileCount = numberValue(row?.local_file_count)
      cloudCopyCount = numberValue(row?.cloud_copy_count)
      publicMaterialCount = numberValue(row?.public_material_count)
    }

    const referencedTasks = new Set<string>()
    if (materialIds.size || folderIds.size) {
      const drafts = database.prepare(`
        SELECT task_id, snapshot_json FROM local_task_draft
      `).all() as SqlRow[]
      for (const draft of drafts) {
        let snapshot: unknown
        try {
          snapshot = JSON.parse(stringValue(draft.snapshot_json))
        } catch {
          continue
        }
        const pending: unknown[] = [snapshot]
        let referenced = false
        while (pending.length && !referenced) {
          const current = pending.pop()
          if (!current || typeof current !== 'object') continue
          if (Array.isArray(current)) {
            pending.push(...current)
            continue
          }
          const record = current as Record<string, unknown>
          for (const binding of parseMaterialBindings(record.material_bindings)) {
            if (binding.binding_type === 'material' && materialIds.has(binding.material_id)) {
              referenced = true
              break
            }
            if (binding.binding_type === 'folder') {
              if (folderIds.has(binding.folder_id)) {
                referenced = true
                break
              }
              try {
                if (localMaterialIdsForFolder(binding.folder_id, binding.include_subfolders)
                  .some((materialId) => materialIds.has(materialId))) {
                  referenced = true
                  break
                }
              } catch {
                // Ignore stale bindings while calculating the current deletion impact.
              }
            }
          }
          if (!referenced) pending.push(...Object.values(record))
        }
        if (referenced) referencedTasks.add(stringValue(draft.task_id))
      }
    }

    const blockers = publicMaterialCount > 0
      ? [`${publicMaterialCount} 个素材仍处于公开流程，请先取消公开`]
      : []
    return {
      materialCount: materialIds.size,
      folderCount: folderIds.size,
      localFileCount,
      cloudCopyCount,
      publicMaterialCount,
      taskReferenceCount: referencedTasks.size,
      canDelete: blockers.length === 0,
      blockers,
    }
  }

  function materialIdsForGeneration(options: PrepareGenerationManifestOptions): string[] {
    const ids = new Set<string>()
    for (const shot of options.shots) {
      if (shot.download_material !== false) continue
      for (const binding of parseMaterialBindings(shot.material_bindings)) {
        if (binding.binding_type === 'material') ids.add(binding.material_id)
        else {
          for (const materialId of localMaterialIdsForFolder(
            binding.folder_id,
            binding.include_subfolders,
          )) ids.add(materialId)
        }
      }
    }
    return [...ids]
  }

  function summarizeMaterialSelection(bindingsValue: unknown): MaterialSelectionSummary {
    const candidates = new Set<string>()
    const selections = parseMaterialBindings(bindingsValue).map((binding) => ({
      key: binding.binding_type === 'material'
        ? `material:${binding.material_id}` : `folder:${binding.folder_id}`,
      materialIds: binding.binding_type === 'material'
        ? [binding.material_id]
        : localMaterialIdsForFolder(binding.folder_id, binding.include_subfolders),
    }))
    const materialIds = [...new Set(selections.flatMap((selection) => selection.materialIds))]
    const keysByMaterial = new Map<string, string>()
    for (let offset = 0; offset < materialIds.length; offset += 500) {
      const batch = materialIds.slice(offset, offset + 500)
      const rows = database.prepare(`
        SELECT material_id, asset_id, asset_version FROM material
        WHERE material_id IN (${batch.map(() => '?').join(',')}) AND deleted_at IS NULL
      `).all(...batch) as SqlRow[]
      for (const row of rows) {
        const materialId = stringValue(row.material_id)
        const assetId = stringValue(row.asset_id)
        keysByMaterial.set(materialId, assetId
          ? `asset:${assetId}:${numberValue(row.asset_version) || 1}`
          : `material:${materialId}`)
      }
    }
    const entries = selections.map(({ key, materialIds: selectedIds }) => {
      const unique = new Set<string>()
      for (const materialId of selectedIds) {
        const candidateKey = keysByMaterial.get(materialId)
        if (!candidateKey) throw new Error(`素材不存在或已删除：${materialId}`)
        unique.add(candidateKey)
        candidates.add(candidateKey)
      }
      return { key, candidateKeys: [...unique].sort() }
    })
    return { candidateCount: candidates.size, entries }
  }

  function moveFile(previousPath: string, nextPath: string, nextFolderId?: string): void {
    const previousRelativePath = relativePathFor(previousPath)
    const nextRelativePath = relativePathFor(nextPath)
    const stat = fs.statSync(nextPath)
    const row = database.prepare(`
      SELECT local_file_id
      FROM local_asset_file
      WHERE relative_path = ?
    `).get(previousRelativePath) as SqlRow | undefined
    if (!row) return
    const localFileId = stringValue(row.local_file_id)
    const affected = database.prepare(`
      SELECT m.material_id, m.cloud_revision, a.cloud_status
      FROM material m
      JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
      WHERE m.material_id IN (
        SELECT material_id FROM local_material_file_map WHERE local_file_id = ?
      ) AND m.deleted_at IS NULL
    `).all(localFileId) as SqlRow[]
    const timestamp = now()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        UPDATE local_asset_file
        SET relative_path = ?, mtime = ?, updated_at = ?
        WHERE local_file_id = ?
      `).run(nextRelativePath, stat.mtimeMs, timestamp, localFileId)
      database.prepare(`
        UPDATE material
        SET display_name = ?,
            local_folder_id = CASE WHEN ? IS NULL THEN local_folder_id ELSE ? END,
            folder_id = CASE
              WHEN ? IS NULL OR cloud_folder_id IS NOT NULL THEN folder_id
              ELSE ?
            END,
            revision = revision + 1, updated_at = ?
        WHERE material_id IN (
          SELECT material_id
          FROM local_material_file_map
          WHERE local_file_id = ?
        )
      `).run(
        path.basename(nextPath),
        nextFolderId || null,
        nextFolderId || null,
        nextFolderId || null,
        nextFolderId || null,
        timestamp,
        localFileId,
      )
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    for (const material of affected) {
      const hasCloudRecord = numberValue(material.cloud_revision) > 0
        || stringValue(material.cloud_status) !== 'not_uploaded'
      if (hasCloudRecord) {
        queueCloudOperation('sync_material', stringValue(material.material_id), {})
      }
    }
  }

  function moveMaterial(materialIdValue: string, nextFolderIdValue: string): void {
    const materialId = stringValue(materialIdValue).trim()
    const nextFolderId = stringValue(nextFolderIdValue).trim()
    const material = getMaterialCloudFileById(materialId)
    const folder = getFolder(nextFolderId)
    if (!material) throw new Error('待移动素材不存在')
    if (!folder || folder.scope !== 'user') throw new Error('目标文件夹不可写入素材')
    const movingLocalMembership = material.localStatus === 'present' || !material.cloudFolderId
    if ((movingLocalMembership ? material.localFolderId : material.cloudFolderId) === nextFolderId) return

    const timestamp = now()
    if (movingLocalMembership) {
      database.prepare(`
        UPDATE material
        SET local_folder_id = ?,
            folder_id = CASE WHEN cloud_folder_id IS NULL THEN ? ELSE folder_id END,
            revision = revision + 1, updated_at = ?
        WHERE material_id = ? AND deleted_at IS NULL
      `).run(nextFolderId, nextFolderId, timestamp, materialId)
    } else {
      database.prepare(`
        UPDATE material
        SET cloud_folder_id = ?, folder_id = ?,
            revision = revision + 1, updated_at = ?
        WHERE material_id = ? AND deleted_at IS NULL
      `).run(nextFolderId, nextFolderId, timestamp, materialId)
    }

    const hasCloudRecord = material.cloudRevision > 0 || material.cloudStatus !== 'not_uploaded'
    if (hasCloudRecord) queueCloudOperation('sync_material', materialId, {})
  }

  function removeLocalCopy(materialIdValue: string): void {
    const materialId = stringValue(materialIdValue).trim()
    const material = getMaterialCloudFileById(materialId)
    if (!material) throw new Error('素材不存在')
    if (material.cloudStatus !== 'ready' || material.cloudRevision < 1) {
      throw new Error('云端副本尚未校验完成，不能删除本机副本')
    }
    try {
      const stat = fs.lstatSync(material.localPath)
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(material.localPath)
    } catch (error) {
      if (stringValue((error as NodeJS.ErrnoException)?.code) !== 'ENOENT') throw error
    }
    database.prepare(`
      UPDATE local_asset_file
      SET local_status = 'missing', updated_at = ?
      WHERE local_file_id IN (
        SELECT local_file_id FROM local_material_file_map WHERE material_id = ?
      )
    `).run(now(), materialId)
  }

  function deleteFile(filePath: string): void {
    const relativePath = relativePathFor(filePath)
    const row = database.prepare(`
      SELECT local_file_id
      FROM local_asset_file
      WHERE relative_path = ?
    `).get(relativePath) as SqlRow | undefined
    if (!row) return
    const localFileId = stringValue(row.local_file_id)
    const affected = database.prepare(`
      SELECT m.material_id, m.revision, m.cloud_revision, a.cloud_status
      FROM material m
      JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
      WHERE m.material_id IN (
        SELECT material_id FROM local_material_file_map WHERE local_file_id = ?
      ) AND m.deleted_at IS NULL
    `).all(localFileId) as SqlRow[]
    const timestamp = now()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        UPDATE local_asset_file
        SET local_status = 'missing', updated_at = ?
        WHERE local_file_id = ?
      `).run(timestamp, localFileId)
      database.prepare(`
        UPDATE material
        SET deleted_at = ?, revision = revision + 1, updated_at = ?
        WHERE material_id IN (
          SELECT material_id
          FROM local_material_file_map
          WHERE local_file_id = ?
        )
      `).run(timestamp, timestamp, localFileId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    for (const material of affected) {
      const hasCloudRecord = numberValue(material.cloud_revision) > 0
        || stringValue(material.cloud_status) !== 'not_uploaded'
      if (!hasCloudRecord) continue
      queueCloudOperation('sync_material', stringValue(material.material_id), {
        deleted: true,
        revision: Math.max(1, numberValue(material.cloud_revision)),
      })
    }
  }

  function setAnalysisStatusForFile(
    filePath: string,
    status: MaterialFileIdentity['analysisStatus'],
    error = '',
    queueCloudSync = true,
  ): void {
    const relativePath = relativePathFor(filePath)
    const timestamp = now()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        UPDATE asset
        SET analysis_status = ?, analysis_error = ?, updated_at = ?
        WHERE (asset_id, asset_version) IN (
          SELECT asset_id, asset_version
          FROM local_asset_file
          WHERE relative_path = ?
        )
      `).run(status, status === 'failed' ? error.trim() || null : null, timestamp, relativePath)
      if (status === 'ready' && queueCloudSync) {
        const materials = database.prepare(`
          SELECT DISTINCT m.material_id
          FROM material m
          JOIN local_material_file_map map ON map.material_id=m.material_id
          JOIN local_asset_file file ON file.local_file_id=map.local_file_id
          WHERE file.relative_path=? AND m.deleted_at IS NULL
        `).all(relativePath) as SqlRow[]
        for (const material of materials) {
          queueAnalysisSyncIfReady(stringValue(material.material_id))
        }
      }
      database.exec('COMMIT')
    } catch (operationError) {
      database.exec('ROLLBACK')
      throw operationError
    }
  }

  function queueAnalysisSyncIfReady(materialIdValue: unknown): boolean {
    const materialId = stringValue(materialIdValue).trim()
    const row = database.prepare(`
      SELECT a.analysis_status, a.cloud_status,
             EXISTS(
               SELECT 1 FROM local_sync_outbox outbox
               WHERE outbox.operation_type='upload'
                 AND outbox.entity_id=m.material_id
                 AND outbox.status IN ('queued', 'processing')
             ) AS upload_pending
      FROM material m
      JOIN asset a ON a.asset_id=m.asset_id AND a.asset_version=m.asset_version
      WHERE m.material_id=? AND m.deleted_at IS NULL
    `).get(materialId) as SqlRow | undefined
    if (!row || stringValue(row.analysis_status) !== 'ready') return false
    const backupRequested = stringValue(row.cloud_status) !== 'not_uploaded'
      || numberValue(row.upload_pending) === 1
    if (!backupRequested) return false
    queueCloudOperation('sync_analysis', materialId, {})
    return true
  }

  function saveTaskDraft<T>(options: SaveTaskDraftOptions<T>): TaskDraftRecord<T> {
    const taskId = options.taskId.trim()
    if (!taskId) throw new Error('task_id 不能为空')
    const existing = database.prepare(`
      SELECT revision
      FROM local_task_draft
      WHERE task_id = ?
    `).get(taskId) as SqlRow | undefined
    const currentRevision = numberValue(existing?.revision)
    if (
      options.expectedRevision !== undefined
      && options.expectedRevision !== currentRevision
    ) {
      throw new Error(`任务草稿版本冲突：期望 ${options.expectedRevision}，当前 ${currentRevision}`)
    }
    const requestedRevision = numberValue(
      options.snapshot && typeof options.snapshot === 'object'
        ? (options.snapshot as Record<string, unknown>).task_revision
        : undefined,
    )
    const creationFloor = !existing && Number.isSafeInteger(requestedRevision) && requestedRevision >= 0
      ? requestedRevision
      : 0
    const revision = existing ? currentRevision + 1 : Math.max(1, creationFloor)
    const updatedAt = now()
    database.prepare(`
      INSERT INTO local_task_draft(
        task_id, schema_version, revision, snapshot_json, save_status, updated_at
      ) VALUES (?, ?, ?, ?, 'saved', ?)
      ON CONFLICT(task_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        snapshot_json = excluded.snapshot_json,
        save_status = 'saved',
        updated_at = excluded.updated_at
    `).run(
      taskId,
      options.schemaVersion,
      revision,
      JSON.stringify(options.snapshot),
      updatedAt,
    )
    return {
      taskId,
      schemaVersion: options.schemaVersion,
      revision,
      snapshot: options.snapshot,
      saveStatus: 'saved',
      updatedAt,
    }
  }

  function loadTaskDraft<T = unknown>(taskIdValue: unknown): TaskDraftRecord<T> | null {
    const taskId = stringValue(taskIdValue).trim()
    if (!taskId) return null
    const row = database.prepare(`
      SELECT task_id, schema_version, revision, snapshot_json, save_status, updated_at
      FROM local_task_draft
      WHERE task_id = ?
    `).get(taskId) as SqlRow | undefined
    if (!row) return null
    return {
      taskId: stringValue(row.task_id),
      schemaVersion: numberValue(row.schema_version),
      revision: numberValue(row.revision),
      snapshot: JSON.parse(stringValue(row.snapshot_json)) as T,
      saveStatus: 'saved',
      updatedAt: stringValue(row.updated_at),
    }
  }

  function materialForId(materialId: string): GenerationManifestItem | null {
    const row = database.prepare(`
      SELECT
        m.material_id, m.asset_id, m.asset_version,
        f.local_file_id, f.source_sha256, f.source_size, f.relative_path, f.mtime, f.local_status,
        a.analysis_status, a.analysis_error
      FROM material m
      JOIN local_material_file_map map ON map.material_id = m.material_id
      JOIN local_asset_file f ON f.local_file_id = map.local_file_id
      JOIN asset a ON a.asset_id = m.asset_id AND a.asset_version = m.asset_version
      WHERE m.material_id = ? AND m.deleted_at IS NULL
      LIMIT 1
    `).get(materialId) as SqlRow | undefined
    if (!row || reconcileLocalFileState(row, true) !== 'present') return null
    const analysisStatus = stringValue(row.analysis_status)
    if (analysisStatus !== 'ready') {
      const reason = stringValue(row.analysis_error)
      throw new Error(
        `素材尚未完成分析：${materialId}（${analysisStatus || 'pending'}${reason ? `：${reason}` : ''}）`,
      )
    }
    const localPath = absolutePathFor(stringValue(row.relative_path))
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) return null
    return {
      material_id: stringValue(row.material_id),
      asset_id: stringValue(row.asset_id),
      asset_version: numberValue(row.asset_version),
      source_sha256: stringValue(row.source_sha256),
      local_path: localPath,
    }
  }

  function folderDirectory(folder: MaterialFolderIdentity): string | null {
    if (folder.scope === 'user') {
      const directory = folder.storageKey === '.'
        ? materialsDir
        : path.resolve(materialsDir, folder.storageKey)
      return isInsideDirectory(directory, materialsDir) ? directory : null
    }
    if (folder.scope === 'downloads') {
      const directory = folder.storageKey === '.'
        ? runsDir
        : path.resolve(runsDir, folder.storageKey)
      return isInsideDirectory(directory, runsDir) ? directory : null
    }
    return null
  }

  function ensureFolderIdentityForDirectory(
    scope: Exclude<MaterialFolderScope, 'virtual'>,
    directory: string,
    boundary: string,
    parentFolderId?: string,
  ): string {
    const storageKey = normalizeStorageKey(path.relative(boundary, directory))
    return getOrCreateFolder({
      scope,
      storageKey,
      name: path.basename(directory) || (scope === 'user' ? '本地素材' : '云端素材'),
      parentFolderId,
    })
  }

  function registerFolderFiles(
    folderId: string,
    includeSubfolders: boolean,
  ): GenerationManifestItem[] {
    const folder = getFolder(folderId)
    if (!folder) throw new Error(`素材文件夹不存在：${folderId}`)
    const baseDirectory = folderDirectory(folder)
    if (!baseDirectory || !fs.existsSync(baseDirectory)) {
      throw new Error(`素材文件夹当前设备不可用：${folderId}`)
    }
    const cloudCacheDirectory = path.join(materialsDir, 'cloud')
    if (isInsideDirectory(baseDirectory, cloudCacheDirectory)) {
      throw new Error('云端下载缓存不能作为本地素材范围，请从当前账号的云端素材选择')
    }
    const scope = folder.scope as Exclude<MaterialFolderScope, 'virtual'>
    const boundary = scope === 'user' ? materialsDir : runsDir
    const addedFrom: MaterialAddedFrom = scope === 'user' ? 'user_import' : 'task_download'
    const origin: MaterialOrigin = scope === 'user' ? 'user_upload' : 'platform_download'
    const pending = [baseDirectory]
    const items: GenerationManifestItem[] = []

    while (pending.length) {
      const current = pending.pop()
      if (!current) break
      const currentFolderId = current === baseDirectory
        ? folderId
        : ensureFolderIdentityForDirectory(scope, current, boundary)
      const entries = fs.readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const candidate = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (
            includeSubfolders
            && entry.name !== '_indexed_h264'
            && entry.name !== '.videoautocut'
            && !isInsideDirectory(candidate, cloudCacheDirectory)
          ) pending.push(candidate)
          continue
        }
        if (!entry.isFile() || !VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase())) continue
        const identity = registerMaterialFile(candidate, {
          folderId: currentFolderId,
          origin,
          addedFrom,
        })
        const material = materialForId(identity.materialId)
        if (material) items.push(material)
      }
      if (!includeSubfolders) break
    }
    for (const materialId of localMaterialIdsForFolder(folderId, includeSubfolders)) {
      const material = materialForId(materialId)
      if (!material) throw new Error(`素材当前设备不可用：${materialId}`)
      items.push(material)
    }
    const unique = new Map<string, GenerationManifestItem>()
    for (const item of items) unique.set(`${item.asset_id}:${item.asset_version}`, item)
    return [...unique.values()]
  }

  function resumeMaterialShots(options: PrepareGenerationManifestOptions) {
    return verifiedResumeMaterialShots(dataRoot, options, getMaterialCloudFileById)
  }

  function prepareGenerationManifest(
    options: PrepareGenerationManifestOptions,
  ): { manifest: GenerationMaterialManifest; manifestPath: string } {
    const taskId = options.taskId.trim()
    if (!taskId) throw new Error('task_id 不能为空')
    const runId = `run_${randomUUID().replaceAll('-', '')}`
    const manifestShots: GenerationManifestShot[] = []
    const resumed = new Map(resumeMaterialShots(options).map(shot => [shot.shot_id, shot]))
    for (const shot of options.shots) {
      const shotId = stringValue(shot.shot_id).trim()
      if (!shotId) throw new Error('分镜缺少 shot_id')
      const reused = resumed.get(shotId)
      if (reused) { manifestShots.push(reused); continue }
      const downloadMaterial = shot.download_material !== false
      const bindings = parseMaterialBindings(shot.material_bindings)
      if (downloadMaterial) {
        if (bindings.length) throw new Error(`分镜 ${shotId} 使用自动下载时不能保留素材绑定`)
        manifestShots.push({ shot_id: shotId, materials: [] })
        continue
      }
      if (!bindings.length) throw new Error(`分镜 ${shotId} 尚未选择素材`)

      const candidates: GenerationManifestItem[] = []
      for (const binding of bindings) {
        if (binding.binding_type === 'material') {
          const material = materialForId(binding.material_id)
          if (!material) throw new Error(`素材当前设备不可用：${binding.material_id}`)
          candidates.push(material)
        } else {
          candidates.push(...registerFolderFiles(
            binding.folder_id,
            binding.include_subfolders,
          ))
        }
      }

      const unique = new Map<string, GenerationManifestItem>()
      for (const candidate of candidates) {
        unique.set(`${candidate.asset_id}:${candidate.asset_version}`, candidate)
      }
      if (!unique.size) throw new Error(`分镜 ${shotId} 的素材候选数量为 0`)
      manifestShots.push({ shot_id: shotId, materials: [...unique.values()] })
    }

    const manifest: GenerationMaterialManifest = {
      schema_version: 1,
      run_id: runId,
      task_id: taskId,
      task_revision: options.taskRevision,
      resolved_at: now(),
      shots: manifestShots,
    }
    const manifestPath = path.join(manifestsDir, `${runId}.json`)
    const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8')
    fs.renameSync(temporaryPath, manifestPath)
    return { manifest, manifestPath }
  }

  function prepareGenerationManifestFromSnapshot(
    input: FrozenGenerationManifestInput,
  ): { manifest: GenerationMaterialManifest; manifestPath: string } {
    const runId = input.runId.trim()
    const taskId = input.taskId.trim()
    if (!/^run_[A-Za-z0-9_-]{5,92}$/.test(runId)) throw new Error('云端运行标识无效')
    if (!taskId) throw new Error('task_id 不能为空')
    if (!Number.isInteger(input.taskRevision) || input.taskRevision < 1) {
      throw new Error('task_revision 无效')
    }
    const resumed = new Map((input.resumeOptions ? resumeMaterialShots(input.resumeOptions) : []).map(shot => [shot.shot_id, shot]))
    const manifestShots: GenerationManifestShot[] = input.shots.map((shot) => {
      const shotId = shot.shot_id.trim()
      if (!shotId) throw new Error('分镜缺少 shot_id')
      const materials = shot.materials.map((frozen) => {
        const cached = resumed.get(shotId)?.materials.find(item => sameFrozenMaterial(item, frozen))
        if (cached) return cached
        const local = materialForId(frozen.material_id)
        if (!local) {
          const identity = getMaterialCloudFileById(frozen.material_id)
          if (identity?.localStatus === 'damaged') {
            throw new Error(`素材文件内容校验失败：${frozen.material_id}`)
          }
          throw new Error(`素材当前设备不可用：${frozen.material_id}`)
        }
        if (
          local.asset_id !== frozen.asset_id
          || local.asset_version !== frozen.asset_version
          || local.source_sha256 !== frozen.source_sha256
        ) {
          throw new Error(`素材版本与云端生成清单不一致：${frozen.material_id}`)
        }
        if (computeSha256(local.local_path) !== frozen.source_sha256) {
          throw new Error(`素材文件内容校验失败：${frozen.material_id}`)
        }
        return local
      })
      return { shot_id: shotId, materials }
    })
    const manifest: GenerationMaterialManifest = {
      schema_version: 1,
      run_id: runId,
      task_id: taskId,
      task_revision: input.taskRevision,
      resolved_at: now(),
      shots: manifestShots,
    }
    const manifestPath = path.join(manifestsDir, `${runId}.json`)
    const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8')
    fs.renameSync(temporaryPath, manifestPath)
    return { manifest, manifestPath }
  }

  function close(): void {
    database.close()
  }

  return {
    cancelCloudUpload,
    claimCloudOperations,
    applyCloudDeletion,
    close,
    cloudOperationCounts,
    cloudConflictCount,
    completeCloudDownload,
    completeCloudOperation,
    deleteFolder,
    deleteFile,
    describeFile,
    describeKnownFile,
    getCloudState,
    getCloudFolderRecord,
    getDeletionImpact,
    getFolder,
    getMaterialReadRevision,
    withMaterialReadSnapshot,
    folderChainForMaterial,
    getOrCreateFolder,
    getMaterialCloudFileById,
    getCloudDownloadSource,
    getMaterialCloudFileByPath,
    getTransferSession,
    importMaterialFile,
    importMaterialFileWithProgress,
    listFolderFiles,
    listCloudFiles,
    listFolders,
    listCloudUploadCandidates,
    loadTaskDraft,
    moveFile,
    moveFolder,
    moveMaterial,
    isFolderStorageDeleted,
    removeLocalCopy,
    materialIdsForGeneration,
    summarizeMaterialSelection,
    prepareGenerationManifest,
    prepareGenerationManifestFromSnapshot,
    resumeMaterialShots,
    pauseCloudUpload,
    queueAnalysisSyncIfReady,
    markCloudAnalysisReady,
    queueCloudOperation,
    releaseCloudOperation,
    registerMaterialFile,
    saveTaskDraft,
    saveTransferSession,
    setAnalysisStatusForFile,
    setCloudState,
    setCloudRevisionForFolder,
    setCloudRevisionForMaterial,
    setCloudStatusForMaterial,
    retryCloudOperation,
    resumeCloudUpload,
    upsertCloudFolder,
    upsertCloudMaterial,
  }
}

export {
  createMaterialLocalStore,
  parseMaterialBindings,
  type GenerationMaterialManifest,
  type FrozenGenerationManifestInput,
  type CloudFolderRecord,
  type CloudMaterialRecord,
  type MaterialBindingInput,
  type MaterialSelectionSummary,
  type MaterialSelectionSummaryOptions,
  type MaterialCloudFile,
  type MaterialDeletionImpact,
  type MaterialCloudOperation,
  type MaterialCloudOperationType,
  type MaterialIdentityStore,
  type MaterialFolderIdentity,
  type MaterialFolderScope,
  type MaterialLocalStoreOptions,
  type MaterialTransferSession,
  type PrepareGenerationManifestOptions,
  type SaveTaskDraftOptions,
  type TaskDraftRecord,
}
