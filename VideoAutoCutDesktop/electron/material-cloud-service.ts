import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import { IPC_EVENTS } from './ipc-channels.js'
import { canonicalAnalysisJson } from './analysis-provenance.js'
import { createLocalMediaUrl } from './local-media-protocol.js'
import { parseAnalysisExport, type MaterialAnalysisExport } from './material-analysis-exporter.js'
import type {
  CloudFolderRecord,
  CloudMaterialRecord,
  FrozenGenerationManifestInput,
  MaterialCloudFile,
  MaterialCloudOperation,
  MaterialTransferSession,
  PrepareGenerationManifestOptions,
} from './material-local-store.js'
import { asRecord, errorMessage, numberValue, stringValue, type IpcSender, type JsonRecord } from './types.js'
import { ensureDir } from './utils.js'
import { sameFrozenMaterial, type ResumeMaterialShot } from './resume-material-manifest.js'

interface MaterialCloudStore {
  applyCloudDeletion(entityType: unknown, entityId: unknown, revision: unknown): void
  cancelCloudUpload(materialId: unknown): boolean
  claimCloudOperations(limit?: number): MaterialCloudOperation[]
  cloudConflictCount?: () => number
  cloudOperationCounts(): { pending: number; failed: number }
  completeCloudDownload(materialId: unknown, filePath: string, sourceSha256: string, sourceSize: number): void
  completeCloudOperation(operationId: unknown): void
  getCloudState(key: unknown): string
  getCloudFolderRecord(folderId: unknown): CloudFolderRecord | null
  folderChainForMaterial(materialId: unknown): CloudFolderRecord[]
  getMaterialCloudFileById(materialId: unknown): MaterialCloudFile | null
  getCloudDownloadSource?: (materialId: unknown) => MaterialCloudFile | null
  getMaterialCloudFileByPath(filePath: string): MaterialCloudFile | null
  getTransferSession(materialId: unknown, direction: 'upload' | 'download'): MaterialTransferSession | null
  listCloudUploadCandidates(origins: Array<'user_upload' | 'platform_download'>): MaterialCloudFile[]
  materialIdsForGeneration(options: PrepareGenerationManifestOptions): string[]
  pauseCloudUpload(materialId: unknown): boolean
  prepareGenerationManifest(options: PrepareGenerationManifestOptions): unknown
  prepareGenerationManifestFromSnapshot(options: FrozenGenerationManifestInput): unknown
  resumeMaterialShots?: (options: PrepareGenerationManifestOptions) => ResumeMaterialShot[]
  queueAnalysisSyncIfReady(materialId: unknown): boolean
  markCloudAnalysisReady(material: MaterialCloudFile): void
  queueCloudOperation(operationType: 'upload' | 'delete_cloud_copy' | 'sync_material' | 'sync_folder' | 'sync_analysis' | 'restore_analysis' | 'update_generation', entityId: unknown, payload?: Record<string, unknown>): MaterialCloudOperation
  retryCloudOperation(operationId: unknown, error: unknown, retryAt: string): void
  releaseCloudOperation?: (operationId: unknown) => void
  resumeCloudUpload(materialId: unknown): boolean
  saveTransferSession(session: MaterialTransferSession): void
  setCloudState(key: unknown, value: unknown): void
  setCloudRevisionForFolder(folderId: unknown, revision: unknown): void
  setCloudRevisionForMaterial(materialId: unknown, revision: unknown): void
  setAnalysisStatusForFile(filePath: string, status: MaterialCloudFile['analysisStatus'], error?: string, queueCloudSync?: boolean): void
  setCloudStatusForMaterial(materialId: unknown, status: MaterialCloudFile['cloudStatus'], error?: string): void
  upsertCloudFolder(record: CloudFolderRecord): void
  upsertCloudMaterial(record: CloudMaterialRecord): void
}

interface MaterialCloudServiceOptions {
  deviceId: string
  readAuthState: () => unknown
  readEnv: () => Record<string, string>
  readPlatformEnv?: () => Record<string, string>
  defaultApiBaseUrl?: string
  send: IpcSender
  store: MaterialCloudStore
  exportAnalysisResult: (filePath: string) => Promise<MaterialAnalysisExport>
  importAnalysisResult: (filePath: string, value: unknown) => Promise<unknown>
  requestLocalAnalysis?: (paths: string[]) => void
  request?: typeof fetch
  uploadFile?: typeof uploadFileRange
  downloadFile?: typeof downloadToFile
  isSessionActive?: () => boolean
  transferAbortSignal?: AbortSignal
}

interface MaterialCloudStatus {
  configured: boolean
  authenticated: boolean
  online: boolean
  syncing: boolean
  pendingOperations: number
  failedOperations: number
  conflicts: number
  progress?: { phase: string; completed: number; total: number }
  lastSyncAt?: string
  lastError?: string
}

interface UploadAuthorization {
  partNumber: number
  method: 'PUT'
  url: string
  headers: Record<string, string>
}

class UploadControlSignal extends Error {
  readonly action: 'paused' | 'canceled'

  constructor(action: 'paused' | 'canceled') {
    super(action === 'paused' ? '上传已暂停' : '上传已取消')
    this.action = action
  }
}

class WaitingForLocalAnalysis extends Error {}

const API_BASE_ENV_KEYS = [
  'VIDEOAUTO_MATERIAL_API_BASE_URL',
  'VIDEOAUTOCUT_MATERIAL_API_BASE_URL',
] as const
const MAX_LIST_PAGES = 100
const MAX_ANALYSIS_PAGES = 100
const MAX_PARALLEL_PARTS = 4
const QUEUE_BATCH_SIZE = 2

function sanitizedError(value: unknown, fallback = '云素材服务请求失败'): string {
  return errorMessage(value, fallback)
    .replace(/https?:\/\/[^\s"']+/gi, '[已隐藏临时地址]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .slice(0, 1000)
}

function normalizeApiBase(value: unknown): string {
  const raw = String(value || '').trim().replace(/\/+$/g, '')
  if (!raw) return ''
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return ''
  }
  const localDevelopment = parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  if (parsed.protocol !== 'https:' && !localDevelopment) return ''
  return parsed.toString().replace(/\/+$/g, '')
}

function assertTemporaryUrl(value: unknown): URL {
  const parsed = new URL(String(value || ''))
  if (parsed.protocol !== 'https:') throw new Error('云存储临时地址必须使用 HTTPS')
  return parsed
}

function normalizedHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (!key.trim() || item === undefined || item === null) continue
    result[key] = String(item)
  }
  return result
}

function chromiumUploadHeaders(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key.trim().toLocaleLowerCase() !== 'content-length'),
  )
}

function computeSha256(filePath: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let read = 0
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (read > 0) hash.update(buffer.subarray(0, read))
    } while (read > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function cloudOpaqueId(prefix: string, value: unknown): string {
  const raw = stringValue(value).trim()
  if (/^[A-Za-z0-9_-]{5,96}$/.test(raw)) return raw
  return `${prefix}_${createHash('sha256').update(raw).digest('hex')}`
}

function stableOperationKey(prefix: string, ...values: unknown[]): string {
  const digest = createHash('sha256').update(values.map(String).join('\0')).digest('hex')
  return `${prefix}-${digest.slice(0, 48)}`
}

function computeRangeSha256(filePath: string, start: number, end: number): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
  try {
    let offset = start
    while (offset <= end) {
      const length = Math.min(buffer.length, end - offset + 1)
      const read = fs.readSync(descriptor, buffer, 0, length, offset)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function transferSpeedBytesPerSecond(
  startedBytes: number,
  currentBytes: number,
  startedAt: number,
  currentAt: number,
): number {
  const transferredBytes = Math.max(0, currentBytes - startedBytes)
  const elapsedMs = Math.max(0, currentAt - startedAt)
  if (!transferredBytes || !elapsedMs) return 0
  return Math.max(0, Math.round(transferredBytes * 1000 / elapsedMs))
}

function downloadContentRangeMatches(value: unknown, start: number, expectedSize: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || ''))
  const responseStart = Number(match?.[1])
  const responseEnd = Number(match?.[2])
  const responseTotal = match?.[3] === '*' ? Number.NaN : Number(match?.[3])
  return Boolean(
    match
    && responseStart === start
    && responseEnd >= responseStart
    && responseEnd < expectedSize
    && responseTotal === expectedSize,
  )
}

function uploadFileRange(
  authorization: UploadAuthorization,
  filePath: string,
  start: number,
  end: number,
): Promise<{ etag: string; bytes: number }> {
  const target = assertTemporaryUrl(authorization.url)
  if (authorization.method !== 'PUT') throw new Error('不支持的云存储上传方法')
  const bytes = end - start + 1
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'PUT',
      headers: {
        ...authorization.headers,
        'Content-Length': String(bytes),
      },
    }, (response) => {
      response.resume()
      response.on('end', () => {
        const status = response.statusCode || 0
        if (status < 200 || status >= 300) {
          reject(new Error(`云存储上传失败（HTTP ${status}）`))
          return
        }
        resolve({
          etag: String(response.headers.etag || '').replace(/^"|"$/g, ''),
          bytes,
        })
      })
    })
    request.on('error', reject)
    const source = fs.createReadStream(filePath, { start, end })
    source.on('error', (error) => request.destroy(error))
    source.pipe(request)
  })
}

async function uploadFileRangeWithFetch(
  request: typeof fetch,
  authorization: UploadAuthorization,
  filePath: string,
  start: number,
  end: number,
): Promise<{ etag: string; bytes: number }> {
  const target = assertTemporaryUrl(authorization.url)
  if (authorization.method !== 'PUT') throw new Error('不支持的云存储上传方法')
  const bytes = end - start + 1
  const file = await fs.promises.open(filePath, 'r')
  const body = Buffer.allocUnsafe(bytes)
  try {
    let offset = 0
    while (offset < bytes) {
      const result = await file.read(body, offset, bytes - offset, start + offset)
      if (!result.bytesRead) throw new Error('读取待上传素材时提前结束')
      offset += result.bytesRead
    }
  } finally {
    await file.close()
  }
  const response = await request(target, {
    method: 'PUT',
    // Chromium owns Content-Length for fetch bodies and rejects a caller-provided value with
    // net::ERR_INVALID_ARGUMENT. The generated value still matches the signed byte range.
    headers: chromiumUploadHeaders(authorization.headers),
    body: body as unknown as BodyInit,
  })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`云存储上传失败（HTTP ${response.status}）`)
  return {
    etag: String(response.headers.get('etag') || '').replace(/^"|"$/g, ''),
    bytes,
  }
}

function downloadToFile(
  urlValue: unknown,
  destination: string,
  start: number,
  expectedSize: number,
  onProgress?: (bytesTransferred: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const target = assertTemporaryUrl(urlValue)
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http
    let outputStream: fs.WriteStream | undefined
    const request = transport.get(target, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal,
    }, (response) => {
      const status = response.statusCode || 0
      if (status !== 200 && status !== 206) {
        response.resume()
        reject(new Error(`云存储下载失败（HTTP ${status}）`))
        return
      }
      if (start > 0 && status !== 206) {
        response.resume()
        reject(Object.assign(new Error('云存储未接受断点下载请求'), { restartDownload: true }))
        return
      }
      if (status === 206) {
        if (!downloadContentRangeMatches(response.headers['content-range'], start, expectedSize)) {
          response.resume()
          reject(Object.assign(new Error('云存储返回了错误的断点范围'), { restartDownload: start > 0 }))
          return
        }
      }
      const output = fs.createWriteStream(destination, { flags: start > 0 ? 'a' : 'w' })
      outputStream = output
      let received = 0
      let outputError: Error | undefined
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress?.(start + received)
      })
      response.on('error', (error) => output.destroy(error))
      output.on('error', (error) => { outputError = error })
      // Do not let a new account/session reuse the partial file before its handle is closed.
      output.on('close', () => {
        if (outputError) { reject(outputError); return }
        onProgress?.(start + received)
        resolve(received)
      })
      response.pipe(output)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('素材下载连接超时，请重试')))
    request.on('error', (error) => {
      if (outputStream && !outputStream.closed) outputStream.destroy(error)
      else reject(error)
    })
  })
}

function createMaterialCloudService(options: MaterialCloudServiceOptions) {
  const request = options.request || fetch
  const uploadFile = options.uploadFile || uploadFileRange
  const downloadFile = options.downloadFile || downloadToFile
  let running = false
  let syncing = false
  let progress = { phase: '等待同步', completed: 0, total: 0 }
  let online = false
  let lastError = ''
  let lastSyncAt = options.store.getCloudState('last_sync_at')
  let queueTimer: NodeJS.Timeout | null = null
  let syncTimer: NodeJS.Timeout | null = null
  let queueWakeRequested = false
  const pausedUploads = new Set<string>()
  const canceledUploads = new Set<string>()
  const materialOperations = new Map<string, Promise<string | undefined>>()
  const localAnalysisProofs = new Map<string, MaterialAnalysisExport>()
  const requestedAnalysisRepairs = new Set<string>()
  const materialMetadataSyncs = new Map<string, Promise<Map<string, string>>>()

  function env(): Record<string, string> {
    return { ...process.env, ...options.readEnv() } as Record<string, string>
  }

  function apiBase(): string {
    const values = options.readPlatformEnv
      ? { ...options.readPlatformEnv(), ...process.env } as Record<string, string>
      : env()
    const configured = normalizeApiBase(API_BASE_ENV_KEYS.map((key) => values[key]).find(Boolean))
    return configured || normalizeApiBase(options.defaultApiBaseUrl)
  }

  function authToken(): string {
    if (options.isSessionActive?.() === false) return ''
    const state = asRecord(options.readAuthState())
    return stringValue(state.accessToken || state.token).trim()
  }

  function materialSyncContext(): string {
    const auth = asRecord(options.readAuthState())
    return createHash('sha256')
      .update(JSON.stringify([apiBase(), authToken(), asRecord(auth.user).id || auth.agentUserId || '']))
      .digest('hex')
  }

  function assertMaterialSyncContext(expected: string): void {
    if (materialSyncContext() !== expected) throw new Error('登录状态或素材服务已变化，请重新开始素材准备')
  }

  function status(): MaterialCloudStatus {
    const counts = options.store.cloudOperationCounts()
    return {
      configured: Boolean(apiBase()),
      authenticated: Boolean(authToken()),
      online,
      syncing,
      progress: { ...progress },
      pendingOperations: counts.pending,
      failedOperations: counts.failed,
      conflicts: options.store.cloudConflictCount?.() || 0,
      lastSyncAt: lastSyncAt || undefined,
      lastError: lastError || undefined,
    }
  }

  function emit(type: string, payload: Record<string, unknown> = {}): void {
    options.send(IPC_EVENTS.materialLibrary, {
      type,
      cloud: status(),
      ...payload,
    })
  }

  function assertUploadAllowed(materialId: string): void {
    if (canceledUploads.has(materialId)) throw new UploadControlSignal('canceled')
    if (pausedUploads.has(materialId)) throw new UploadControlSignal('paused')
  }

  async function api(
    pathname: string,
    requestOptions: {
      method?: string
      body?: unknown
      idempotencyKey?: string
      timeoutMs?: number
    } = {},
  ): Promise<JsonRecord> {
    const base = apiBase()
    if (!base) throw new Error('尚未配置云素材服务地址')
    const token = authToken()
    if (!token) throw new Error('登录已失效，请重新登录后再同步云素材')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs || 30_000)
    try {
      const response = await request(`${base}${pathname}`, {
        method: requestOptions.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'zh-CN',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': options.deviceId,
          ...(requestOptions.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(requestOptions.idempotencyKey ? { 'Idempotency-Key': requestOptions.idempotencyKey } : {}),
        },
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        signal: controller.signal,
      })
      const text = await response.text()
      let data: JsonRecord = {}
      try {
        data = text ? asRecord(JSON.parse(text)) : {}
      } catch {
        data = { message: text }
      }
      if (!response.ok) {
        const errorBody = asRecord(data.error)
        const message = stringValue(errorBody.message || data.message || data.reason || text || `HTTP ${response.status}`)
        throw Object.assign(new Error(message), {
          status: response.status,
          code: stringValue(errorBody.code || data.code),
          retryable: errorBody.retryable === true,
        })
      }
      online = true
      return data
    } finally {
      clearTimeout(timer)
    }
  }

  function uploadAuthorization(value: unknown): UploadAuthorization {
    const record = asRecord(value)
    const method = stringValue(record.method || 'PUT').toUpperCase()
    if (method !== 'PUT') throw new Error('云素材服务返回了不支持的上传方法')
    return {
      partNumber: numberValue(record.part_number),
      method: 'PUT',
      url: stringValue(record.url),
      headers: normalizedHeaders(record.headers || record.required_headers),
    }
  }

  function folderChainForFolder(folderIdValue: unknown): CloudFolderRecord[] {
    const chain: CloudFolderRecord[] = []
    const visited = new Set<string>()
    let current = options.store.getCloudFolderRecord(folderIdValue)
    while (current && !visited.has(current.folderId) && chain.length < 100) {
      visited.add(current.folderId)
      chain.unshift(current)
      current = current.parentFolderId
        ? options.store.getCloudFolderRecord(current.parentFolderId)
        : null
    }
    return chain
  }

  function applySyncResults(response: JsonRecord): void {
    const results = Array.isArray(response.results) ? response.results.map(asRecord) : []
    for (const result of results) {
      const error = asRecord(result.error)
      if (result.ok !== true) {
        throw new Error(stringValue(error.message || '云端元数据同步失败'))
      }
      if (stringValue(result.entity_type) === 'folder') {
        options.store.setCloudRevisionForFolder(result.entity_id, result.revision)
      } else if (stringValue(result.entity_type) === 'material') {
        options.store.setCloudRevisionForMaterial(result.entity_id, result.revision)
      }
    }
  }

  async function resolveUploadFolderChain(
    localFolders: CloudFolderRecord[],
  ): Promise<{ folders: CloudFolderRecord[]; leafFolderId: string }> {
    if (!localFolders.length) return { folders: [], leafFolderId: '' }
    const remoteFolders = (await pagedItems('/v1/folders')).map((item) => ({
      folderId: stringValue(item.folder_id),
      parentFolderId: stringValue(item.parent_folder_id) || undefined,
      name: stringValue(item.name),
      revision: Math.max(1, numberValue(item.revision)),
    })).filter((item) => item.folderId && item.name)
    const resolved: CloudFolderRecord[] = []
    let parentFolderId: string | undefined
    for (const local of localFolders) {
      const remote = remoteFolders.find((candidate) => (
        (candidate.parentFolderId || undefined) === parentFolderId
        && candidate.name.localeCompare(local.name, 'zh-CN', { sensitivity: 'base' }) === 0
      ))
      const folder = remote || {
        ...local,
        parentFolderId,
      }
      resolved.push(folder)
      parentFolderId = folder.folderId
    }
    return {
      folders: resolved,
      leafFolderId: resolved.at(-1)?.folderId || '',
    }
  }

  async function syncMaterialMetadata(material: MaterialCloudFile): Promise<Map<string, string>> {
    const context = materialSyncContext()
    const localFolders = options.store.folderChainForMaterial(material.materialId)
    const metadata = {
      material_id: material.materialId,
      asset_id: material.assetId,
      asset_version: material.assetVersion,
      folder_id: material.cloudFolderId || material.folderId,
      display_name: material.displayName,
      origin: material.origin,
      added_from: material.addedFrom,
      mime_type: material.mimeType,
      file_size_bytes: material.sourceSize,
      source_sha256: material.sourceSha256,
      revision: material.revision,
    }
    // Foreground generation joins an identical background registration, never the whole queue.
    const key = createHash('sha256')
      .update(JSON.stringify([context, localFolders, metadata])).digest('hex')
    const existing = materialMetadataSyncs.get(key)
    if (existing) return existing
    const pending = syncMaterialMetadataRequest(metadata, localFolders, context)
    materialMetadataSyncs.set(key, pending)
    try {
      return await pending
    } finally {
      materialMetadataSyncs.delete(key)
    }
  }

  async function syncMaterialMetadataRequest(metadata: JsonRecord, localFolders: CloudFolderRecord[], context: string): Promise<Map<string, string>> {
    const resolvedFolders = await resolveUploadFolderChain(localFolders)
    assertMaterialSyncContext(context)
    const response = await api('/v1/sync/batch', {
      method: 'POST',
      body: {
        folders: resolvedFolders.folders.map((folder) => ({
          folder_id: folder.folderId,
          parent_folder_id: folder.parentFolderId || null,
          name: folder.name,
          revision: folder.revision,
        })),
        materials: [{
          ...metadata,
          folder_id: resolvedFolders.leafFolderId || metadata.folder_id,
        }],
      },
    })
    assertMaterialSyncContext(context)
    const results = Array.isArray(response.results) ? response.results.map(asRecord) : []
    const acknowledged = results.find(result => result.entity_type === 'material' && result.entity_id === metadata.material_id)
    if (!acknowledged || (acknowledged.ok === true && (!Number.isInteger(acknowledged.revision)
      || Number(acknowledged.revision) < Math.max(1, numberValue(metadata.revision))))) {
      throw new Error('云端未确认素材登记成功，请重试')
    }
    applySyncResults(response)
    return new Map(localFolders.map((folder, index) => [folder.folderId, resolvedFolders.folders[index].folderId]))
  }

  async function requireLocalAnalysis(material: MaterialCloudFile): Promise<MaterialAnalysisExport> {
    if (material.analysisStatus !== 'ready') {
      throw new WaitingForLocalAnalysis('等待本地素材分析完成后上传')
    }
    const repairKey = JSON.stringify([material.assetId, material.assetVersion, material.sourceSha256, material.localPath])
    try {
      const stat = fs.statSync(material.localPath)
      const proofKey = JSON.stringify([material.assetId, material.assetVersion, material.sourceSha256,
        material.sourceSize, material.localPath, stat.size, stat.mtimeMs])
      const cached = localAnalysisProofs.get(proofKey)
      if (cached) return cached
      const result = parseAnalysisExport(await options.exportAnalysisResult(material.localPath))
      localAnalysisProofs.set(proofKey, result)
      requestedAnalysisRepairs.delete(repairKey)
      return result
    } catch (error) {
      if (options.isSessionActive?.() === false) throw error
      const message = sanitizedError(error, '本地分析结果不可用，请重新分析后上传')
      // A stale ready marker is not proof. Keep the upload intent, but do not
      // spend network retry attempts or publish an unsearchable cloud video.
      options.store.setAnalysisStatusForFile(material.localPath, 'failed', message, false)
      if (options.requestLocalAnalysis && !requestedAnalysisRepairs.has(repairKey)) {
        requestedAnalysisRepairs.add(repairKey)
        try { options.requestLocalAnalysis([material.localPath]) } catch (repairError) {
          console.error('[VideoAutoCut] request local analysis repair failed', repairError)
        }
      }
      throw new WaitingForLocalAnalysis(message)
    }
  }

  async function uploadMaterial(operation: MaterialCloudOperation): Promise<void> {
    assertUploadAllowed(operation.entityId)
    const context = materialSyncContext()
    const material = options.store.getMaterialCloudFileById(operation.entityId)
    if (!material) throw new Error('待上传素材不存在')
    if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
      throw new Error('待上传素材在当前设备不存在')
    }
    const stat = fs.statSync(material.localPath)
    if (!stat.isFile() || stat.size !== material.sourceSize) throw new Error('待上传素材文件大小已变化')
    if (computeSha256(material.localPath) !== material.sourceSha256) throw new Error('待上传素材内容校验失败')
    assertUploadAllowed(material.materialId)
    const analysis = await requireLocalAnalysis(material)
    assertMaterialSyncContext(context)
    assertUploadAllowed(material.materialId)
    await syncMaterialMetadata(material)
    assertUploadAllowed(material.materialId)
    await syncAnalysisOperation(operation, analysis, true)
    assertUploadAllowed(material.materialId)
    // Older clients may have uploaded the bytes without their vectors. Repair
    // that state through this same prerequisite without uploading bytes again.
    if (material.cloudStatus === 'ready') return

    options.store.setCloudStatusForMaterial(material.materialId, 'uploading')
    emit('cloud-status', { materialId: material.materialId, path: material.localPath, status: 'uploading' })
    const created = await api('/v1/upload-sessions', {
      method: 'POST',
      idempotencyKey: operation.operationId,
      timeoutMs: 45_000,
      body: {
        material_id: material.materialId,
        filename: material.displayName,
        mime_type: material.mimeType,
        file_size_bytes: material.sourceSize,
        source_sha256: material.sourceSha256,
        origin: material.origin,
        metadata: {},
      },
    })
    const sessionId = stringValue(created.upload_session_id || created.id).trim()
    if (!sessionId) throw new Error('云素材服务没有返回上传会话 ID')
    assertUploadAllowed(material.materialId)
    const reuse = asRecord(created.reuse)
    if (stringValue(reuse.type) === 'own_asset') {
      options.store.setCloudStatusForMaterial(material.materialId, 'ready')
      emit('cloud-status', { materialId: material.materialId, path: material.localPath, status: 'ready' })
      return
    }

    const resumed = await api(`/v1/upload-sessions/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
      timeoutMs: 45_000,
    })
    if (stringValue(resumed.upload_session_id) !== sessionId) {
      throw new Error('云素材服务返回了错误的恢复会话')
    }
    assertUploadAllowed(material.materialId)
    const partSize = Math.max(
      1,
      numberValue(resumed.part_size_bytes) || numberValue(created.part_size_bytes) || material.sourceSize,
    )
    const totalParts = Math.ceil(material.sourceSize / partSize)
    const serverParts = Array.isArray(resumed.completed_parts) ? resumed.completed_parts : []
    const completedParts = new Set<number>()
    for (const raw of serverParts) {
      const partNumber = Math.floor(numberValue(asRecord(raw).part_number || raw))
      if (partNumber < 1 || partNumber > totalParts || completedParts.has(partNumber)) {
        throw new Error('云素材服务返回了无效的恢复分片')
      }
      completedParts.add(partNumber)
    }
    let transferred = [...completedParts].reduce((sum, partNumber) => {
      const start = (partNumber - 1) * partSize
      return sum + Math.max(0, Math.min(partSize, material.sourceSize - start))
    }, 0)
    const progressStartedBytes = transferred
    const progressStartedAt = Date.now()
    const saveSession = (statusValue: string, error = '') => options.store.saveTransferSession({
      sessionId,
      direction: 'upload',
      materialId: material.materialId,
      status: statusValue,
      bytesTransferred: transferred,
      totalBytes: material.sourceSize,
      partSize,
      completedParts: [...completedParts].sort((left, right) => left - right),
      lastError: error || undefined,
    })
    const emitUploadProgress = () => emit('cloud-progress', {
      materialId: material.materialId,
      direction: 'upload',
      bytesTransferred: transferred,
      totalBytes: material.sourceSize,
      speedBytesPerSecond: transferSpeedBytesPerSecond(
        progressStartedBytes,
        transferred,
        progressStartedAt,
        Date.now(),
      ),
    })
    saveSession('uploading')
    emitUploadProgress()

    const pendingParts = Array.from({ length: totalParts }, (_, index) => index + 1)
      .filter((partNumber) => !completedParts.has(partNumber))
    const configuredParallel = numberValue(asRecord(created.upload).max_parallel_parts)
    const parallel = Math.max(1, Math.min(MAX_PARALLEL_PARTS, configuredParallel || MAX_PARALLEL_PARTS))
    for (let offset = 0; offset < pendingParts.length; offset += parallel) {
      assertUploadAllowed(material.materialId)
      const partNumbers = pendingParts.slice(offset, offset + parallel)
      const authorizationResponse = await api(`/v1/upload-sessions/${encodeURIComponent(sessionId)}/part-authorizations`, {
        method: 'POST',
        body: { part_numbers: partNumbers },
      })
      const authorizations = Array.isArray(authorizationResponse.authorizations)
        ? authorizationResponse.authorizations.map(uploadAuthorization)
        : []
      if (authorizations.length !== partNumbers.length) {
        throw new Error('云素材服务返回的分片授权数量不正确')
      }
      await Promise.all(authorizations.map(async (authorization) => {
        const partNumber = authorization.partNumber
        if (!partNumbers.includes(partNumber)) throw new Error('云素材服务返回了无效的分片编号')
        const start = (partNumber - 1) * partSize
        const end = Math.min(material.sourceSize - 1, start + partSize - 1)
        const checksum = computeRangeSha256(material.localPath, start, end)
        const uploaded = await uploadFile(authorization, material.localPath, start, end)
        await api(`/v1/upload-sessions/${encodeURIComponent(sessionId)}/parts/complete`, {
          method: 'POST',
          body: {
            part_number: partNumber,
            size_bytes: uploaded.bytes,
            etag: uploaded.etag,
            checksum,
          },
        })
        if (!completedParts.has(partNumber)) transferred += uploaded.bytes
        completedParts.add(partNumber)
        saveSession('uploading')
        emitUploadProgress()
      }))
      assertUploadAllowed(material.materialId)
    }

    assertUploadAllowed(material.materialId)
    options.store.setCloudStatusForMaterial(material.materialId, 'verifying')
    saveSession('verifying')
    emit('cloud-status', { materialId: material.materialId, path: material.localPath, status: 'verifying' })
    const completed = await api(`/v1/upload-sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
      timeoutMs: 120_000,
    })
    const completedStatus = stringValue(completed.cloud_status || completed.status).toLocaleLowerCase()
    const ready = ['ready', 'completed', 'complete', 'verified'].includes(completedStatus)
    options.store.setCloudStatusForMaterial(material.materialId, ready ? 'ready' : 'verifying')
    saveSession(ready ? 'ready' : 'verifying')
    emit('cloud-status', {
      materialId: material.materialId,
      path: material.localPath,
      status: ready ? 'ready' : 'verifying',
    })
  }

  function retryAt(attemptCount: number): string {
    const delay = Math.min(300_000, 5_000 * (2 ** Math.min(6, Math.max(0, attemptCount))))
    return new Date(Date.now() + delay).toISOString()
  }

  async function deleteCloudEntity(pathname: string, revision: number): Promise<void> {
    try {
      await api(pathname, { method: 'DELETE', body: { revision } })
    } catch (error) {
      if (numberValue(asRecord(error).status) === 404) return
      throw error
    }
  }

  async function syncFolderOperation(operation: MaterialCloudOperation): Promise<void> {
    if (operation.payload.deleted === true) {
      await deleteCloudEntity(
        `/v1/folders/${encodeURIComponent(operation.entityId)}`,
        numberValue(operation.payload.revision),
      )
      return
    }
    const localFolders = folderChainForFolder(operation.entityId)
    if (!localFolders.length) throw new Error('待同步文件夹不存在')
    // A fresh device has different local IDs for the same cloud hierarchy.
    const { folders } = await resolveUploadFolderChain(localFolders)
    const response = await api('/v1/sync/batch', {
      method: 'POST',
      body: {
        folders: folders.map((folder) => ({
          folder_id: folder.folderId,
          parent_folder_id: folder.parentFolderId || null,
          name: folder.name,
          revision: folder.revision,
        })),
        materials: [],
      },
    })
    applySyncResults(response)
  }

  async function syncMaterialOperation(operation: MaterialCloudOperation): Promise<void> {
    if (operation.payload.deleted === true) {
      await deleteCloudEntity(
        `/v1/materials/${encodeURIComponent(operation.entityId)}`,
        numberValue(operation.payload.revision),
      )
      return
    }
    const material = options.store.getMaterialCloudFileById(operation.entityId)
    if (!material) throw new Error('待同步素材不存在')
    await syncMaterialMetadata(material)
  }

  async function syncAnalysisOperation(
    operation: MaterialCloudOperation,
    prepared?: MaterialAnalysisExport,
    metadataRegistered = false,
  ): Promise<void> {
    const context = materialSyncContext()
    const material = options.store.getMaterialCloudFileById(operation.entityId)
    if (!material) throw new Error('待同步分析结果的素材不存在')
    if (material.cloudAnalysisStatus === 'ready') return
    if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
      throw new Error('待同步分析结果的本地素材不存在')
    }
    const result = prepared || await requireLocalAnalysis(material)
    assertMaterialSyncContext(context)
    if (!metadataRegistered && material.cloudStatus !== 'ready' && !material.cloudRevision) await syncMaterialMetadata(material)
    assertMaterialSyncContext(context)
    const response = await api(`/v1/materials/${encodeURIComponent(material.materialId)}/analysis-results`, {
      method: 'POST',
      idempotencyKey: operation.operationId,
      timeoutMs: 120_000,
      body: {
        asset_id: material.assetId,
        asset_version: material.assetVersion,
        source_sha256: material.sourceSha256,
        file_size_bytes: material.sourceSize,
        analysis_profile_id: result.analysis_profile_id,
        ...(result.analysis_provenance ? { analysis_provenance: result.analysis_provenance } : {}),
        embedding_backend: result.embedding_backend,
        model_name: result.model_name,
        model_version: result.model_version,
        dimension: result.dimension,
        result_schema_version: result.result_schema_version,
        chunks: result.chunks,
      },
    })
    assertMaterialSyncContext(context)
    if (!['completed', 'ready'].includes(stringValue(response.analysis_status))
      || response.material_id !== material.materialId) {
      throw new Error('云端未确认分析结果保存成功，请重试同步分析结果')
    }
    options.store.markCloudAnalysisReady(material)
  }

  async function downloadAnalysisResult(material: MaterialCloudFile): Promise<JsonRecord> {
    let cursor = ''
    let combined: JsonRecord | null = null
    const chunks: unknown[] = []
    for (let page = 0; page < MAX_ANALYSIS_PAGES; page += 1) {
      const response = await api(
        `/v1/materials/${encodeURIComponent(material.materialId)}/analysis-results?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      if (!combined) {
        combined = { ...response }
      } else {
        if (canonicalAnalysisJson(response.analysis_provenance ?? null)
          !== canonicalAnalysisJson(combined.analysis_provenance ?? null)) {
          throw new Error('云端分析结果分页参数不一致')
        }
        for (const field of [
          'material_id',
          'asset_id',
          'asset_version',
          'source_sha256',
          'file_size_bytes',
          'analysis_id',
          'analysis_result_version',
          'analysis_profile_id',
          'embedding_backend',
          'model_name',
          'model_version',
          'dimension',
          'result_schema_version',
        ]) {
          if (String(response[field]) !== String(combined[field])) {
            throw new Error('云端分析结果分页身份不一致')
          }
        }
      }
      const pageChunks = Array.isArray(response.chunks) ? response.chunks : []
      chunks.push(...pageChunks)
      if (chunks.length > 10_000) throw new Error('云端分析结果分段数量超出限制')
      const nextCursor = stringValue(response.next_cursor)
      if (response.has_more !== true) {
        if (!chunks.length || !combined) throw new Error('云端分析结果没有可用分段')
        return { ...combined, chunks, next_cursor: null, has_more: false }
      }
      if (!nextCursor || nextCursor === cursor) throw new Error('云端分析结果分页游标无效')
      cursor = nextCursor
    }
    throw new Error('云端分析结果分页数量超出限制')
  }

  async function restoreMaterialAnalysis(material: MaterialCloudFile): Promise<void> {
    const context = materialSyncContext()
    const target = material
    const source = options.store.getCloudDownloadSource?.(material.materialId)
    if (source) material = { ...source, localPath: material.localPath, localStatus: material.localStatus }
    if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
      throw new Error('待恢复分析结果的本地素材不存在')
    }
    const result = await downloadAnalysisResult(material)
    assertMaterialSyncContext(context)
    if (
      stringValue(result.material_id) !== material.materialId
      || stringValue(result.asset_id) !== material.assetId
      || numberValue(result.asset_version) !== material.assetVersion
      || stringValue(result.source_sha256) !== material.sourceSha256
      || numberValue(result.file_size_bytes) !== material.sourceSize
    ) {
      throw new Error('云端分析结果与素材身份不一致')
    }
    await options.importAnalysisResult(material.localPath, result)
    assertMaterialSyncContext(context)
    options.store.setAnalysisStatusForFile(material.localPath, 'ready', '', false)
    emit('cloud-analysis-status', {
      materialId: target.materialId,
      path: material.localPath,
      direction: 'download',
      status: 'ready',
    })
  }

  async function restoreAnalysisOperation(operation: MaterialCloudOperation): Promise<void> {
    const material = options.store.getMaterialCloudFileById(operation.entityId)
    if (!material) throw new Error('待恢复分析结果的素材不存在')
    await restoreMaterialAnalysis(material)
  }

  async function deleteCloudCopyOperation(operation: MaterialCloudOperation): Promise<void> {
    const material = options.store.getMaterialCloudFileById(operation.entityId)
    if (!material) throw new Error('待删除云端副本的素材不存在')
    const revision = Math.floor(numberValue(operation.payload.revision))
    if (revision < 1) throw new Error('待删除云端副本的素材版本无效')
    options.store.setCloudStatusForMaterial(material.materialId, 'deleting')
    emit('cloud-status', {
      materialId: material.materialId,
      path: material.localPath,
      direction: 'delete',
      status: 'deleting',
    })
    const response = await api(
      `/v1/materials/${encodeURIComponent(material.materialId)}/cloud-copy`,
      {
        method: 'DELETE',
        idempotencyKey: operation.operationId,
        timeoutMs: 120_000,
        body: { revision },
      },
    )
    options.store.setCloudRevisionForMaterial(material.materialId, response.revision)
    options.store.setCloudStatusForMaterial(material.materialId, 'not_uploaded')
    emit('cloud-status', {
      materialId: material.materialId,
      path: material.localPath,
      direction: 'delete',
      status: 'not_uploaded',
    })
  }

  async function updateGenerationOperation(operation: MaterialCloudOperation): Promise<void> {
    const desiredStatus = stringValue(operation.payload.status)
    if (!['running', 'succeeded', 'failed', 'canceled'].includes(desiredStatus)) {
      throw new Error('待同步的生成运行状态无效')
    }
    const current = await api(`/v1/generation-runs/${encodeURIComponent(operation.entityId)}`)
    const currentStatus = stringValue(current.status)
    const terminal = ['succeeded', 'failed', 'canceled']
    if (terminal.includes(currentStatus)) return
    const revision = Math.floor(numberValue(current.revision))
    if (revision < 1) throw new Error('云素材服务返回的生成运行版本无效')
    const progress = Math.max(
      numberValue(current.progress),
      Math.max(0, Math.min(100, numberValue(operation.payload.progress))),
    )
    const body: JsonRecord = {
      revision,
      status: desiredStatus,
      stage: stringValue(operation.payload.stage) || 'running',
      progress: desiredStatus === 'succeeded' ? 100 : progress,
    }
    if (operation.payload.current_shot_id) {
      body.current_shot_id = operation.payload.current_shot_id
    }
    if (operation.payload.current_material_id) {
      body.current_material_id = operation.payload.current_material_id
    }
    if (desiredStatus === 'failed') {
      body.error_code = stringValue(operation.payload.error_code) || 'DESKTOP_PROCESS_FAILED'
      body.error_message = stringValue(operation.payload.error_message).slice(0, 2000)
        || '本地生成进程执行失败'
    }
    await api(`/v1/generation-runs/${encodeURIComponent(operation.entityId)}`, {
      method: 'PATCH',
      idempotencyKey: operation.operationId,
      body,
    })
  }

  async function processOperation(operation: MaterialCloudOperation): Promise<string | undefined> {
    if (!['upload', 'sync_analysis'].includes(operation.operationType)) return executeOperation(operation)
    const previous = materialOperations.get(operation.entityId)
    const current = (async () => {
      await previous
      return executeOperation(operation)
    })()
    materialOperations.set(operation.entityId, current)
    try { return await current } finally {
      if (materialOperations.get(operation.entityId) === current) materialOperations.delete(operation.entityId)
    }
  }

  async function executeOperation(operation: MaterialCloudOperation): Promise<string | undefined> {
    try {
      if (options.isSessionActive?.() === false) {
        options.store.releaseCloudOperation?.(operation.operationId)
        return
      }
      if (['sync_analysis', 'restore_analysis'].includes(operation.operationType)) {
        emit('cloud-analysis-status', { materialId: operation.entityId, status: 'processing',
          direction: operation.operationType === 'restore_analysis' ? 'download' : 'upload' })
      }
      if (operation.operationType === 'upload') await uploadMaterial(operation)
      else if (operation.operationType === 'sync_folder') await syncFolderOperation(operation)
      else if (operation.operationType === 'sync_material') await syncMaterialOperation(operation)
      else if (operation.operationType === 'sync_analysis') await syncAnalysisOperation(operation)
      else if (operation.operationType === 'restore_analysis') await restoreAnalysisOperation(operation)
      else if (operation.operationType === 'delete_cloud_copy') await deleteCloudCopyOperation(operation)
      else if (operation.operationType === 'update_generation') await updateGenerationOperation(operation)
      else throw new Error('不支持的云素材操作')
      options.store.completeCloudOperation(operation.operationId)
      if (['sync_analysis', 'restore_analysis'].includes(operation.operationType)) {
        emit('cloud-analysis-status', { materialId: operation.entityId, status: 'ready',
          direction: operation.operationType === 'restore_analysis' ? 'download' : 'upload' })
      }
    } catch (error) {
      if (options.isSessionActive?.() === false) {
        options.store.releaseCloudOperation?.(operation.operationId)
        return
      }
      if (error instanceof WaitingForLocalAnalysis) {
        options.store.releaseCloudOperation?.(operation.operationId)
        emit('cloud-upload-waiting-analysis', { materialId: operation.entityId, message: error.message })
        return
      }
      if (operation.operationType === 'upload') {
        const action = canceledUploads.has(operation.entityId)
          ? 'canceled'
          : pausedUploads.has(operation.entityId)
            ? 'paused'
            : error instanceof UploadControlSignal
              ? error.action
              : ''
        if (action) {
          emit('cloud-upload-control', {
            materialId: operation.entityId,
            status: action,
          })
          return
        }
      }
      const message = sanitizedError(error, operation.operationType === 'sync_analysis' ? '分析结果同步失败'
        : operation.operationType === 'restore_analysis' ? '分析索引恢复失败' : '素材上传失败')
      options.store.retryCloudOperation(operation.operationId, message, retryAt(operation.attemptCount))
      if (operation.operationType === 'upload') {
        try {
          const transfer = options.store.getTransferSession(operation.entityId, 'upload')
          if (transfer) {
            options.store.saveTransferSession({
              ...transfer,
              status: 'failed',
              lastError: message,
            })
          }
          options.store.setCloudStatusForMaterial(operation.entityId, 'failed', message)
        } catch {
          // The local material may have been removed while the upload was in flight.
        }
      }
      lastError = message
      online = false
      emit(['sync_analysis', 'restore_analysis'].includes(operation.operationType) ? 'cloud-analysis-status' : 'cloud-status', {
        materialId: operation.entityId,
        ...(['sync_analysis', 'restore_analysis'].includes(operation.operationType)
          ? { direction: operation.operationType === 'restore_analysis' ? 'download' : 'upload' } : {}),
        status: 'failed',
        message,
      })
      return message
    }
  }

  async function processQueue(): Promise<MaterialCloudStatus> {
    if (running || !apiBase() || !authToken()) return status()
    running = true
    localAnalysisProofs.clear()
    try {
      const operations = options.store.claimCloudOperations(QUEUE_BATCH_SIZE)
      const failures = (await Promise.all(operations.map(processOperation))).filter(Boolean)
      const outstanding = options.store.cloudOperationCounts()
      if (operations.length || (!outstanding.pending && !outstanding.failed)) {
        lastError = failures.join('；')
        if (failures.length) online = false
      }
      return status()
    } finally {
      localAnalysisProofs.clear()
      running = false
      if (queueWakeRequested) {
        queueWakeRequested = false
        setTimeout(() => { void processQueue() }, 0).unref?.()
      }
    }
  }

  function requestQueueProcessing(): void {
    if (running) {
      queueWakeRequested = true
      return
    }
    void processQueue()
  }

  function queueUploads(value: unknown): { queued: number; skipped: number; status: MaterialCloudStatus } {
    const record = asRecord(value)
    const paths = Array.isArray(record.paths) ? record.paths : []
    let queued = 0
    let skipped = 0
    const analysisPaths = new Set<string>()
    for (const pathValue of paths) {
      const material = options.store.getMaterialCloudFileByPath(stringValue(pathValue))
      if (!material || material.localStatus !== 'present'
        || (material.cloudStatus === 'ready' && material.cloudAnalysisStatus === 'ready')) {
        skipped += 1
        continue
      }
      const automatic = record.automatic === true
      if (!automatic) {
        pausedUploads.delete(material.materialId)
        canceledUploads.delete(material.materialId)
      }
      const operation = options.store.queueCloudOperation('upload', material.materialId, { explicitResume: !automatic })
      if (['paused', 'canceled'].includes(operation.status)) { skipped += 1; continue }
      if (!automatic && material.analysisStatus !== 'ready') analysisPaths.add(material.localPath)
      queued += 1
    }
    if (analysisPaths.size) options.requestLocalAnalysis?.([...analysisPaths])
    if (queued) {
      emit('cloud-queue', { queued })
      requestQueueProcessing()
    }
    return { queued, skipped, status: status() }
  }

  async function controlUpload(value: unknown): Promise<{
    ok: boolean
    action?: 'pause' | 'resume' | 'cancel'
    message?: string
    status: MaterialCloudStatus
  }> {
    const record = asRecord(value)
    const materialId = stringValue(record.materialId || record.material_id).trim()
    const action = stringValue(record.action).trim() as 'pause' | 'resume' | 'cancel'
    if (!materialId || !['pause', 'resume', 'cancel'].includes(action)) {
      return { ok: false, message: '上传控制参数无效', status: status() }
    }
    const material = options.store.getMaterialCloudFileById(materialId)
    if (!material) return { ok: false, message: '素材不存在', status: status() }
    const transfer = options.store.getTransferSession(materialId, 'upload')
    if (transfer?.status === 'verifying') {
      return { ok: false, action, message: '云端正在校验文件，当前不能暂停或取消', status: status() }
    }

    if (action === 'pause') {
      canceledUploads.delete(materialId)
      pausedUploads.add(materialId)
      if (!options.store.pauseCloudUpload(materialId)) {
        pausedUploads.delete(materialId)
        return { ok: false, action, message: '当前素材没有可暂停的上传任务', status: status() }
      }
      emit('cloud-upload-control', { materialId, status: 'paused' })
      return { ok: true, action, status: status() }
    }

    if (action === 'resume') {
      if (!options.store.resumeCloudUpload(materialId)) {
        return { ok: false, action, message: '当前素材没有可继续的上传任务', status: status() }
      }
      pausedUploads.delete(materialId)
      canceledUploads.delete(materialId)
      if (material.analysisStatus === 'ready') options.store.setCloudStatusForMaterial(materialId, 'uploading')
      else if (material.localStatus === 'present') options.requestLocalAnalysis?.([material.localPath])
      emit('cloud-upload-control', { materialId, status: 'queued' })
      requestQueueProcessing()
      return { ok: true, action, status: status() }
    }

    const canCancel = options.store.pauseCloudUpload(materialId)
      || ['queued', 'uploading', 'paused', 'failed'].includes(transfer?.status || '')
    if (!canCancel) {
      return { ok: false, action, message: '当前素材没有可取消的上传任务', status: status() }
    }
    pausedUploads.delete(materialId)
    canceledUploads.add(materialId)
    try {
      if (transfer?.sessionId && !['ready', 'canceled'].includes(transfer.status)) {
        try {
          await api(`/v1/upload-sessions/${encodeURIComponent(transfer.sessionId)}/cancel`, {
            method: 'POST',
            timeoutMs: 45_000,
          })
        } catch (error) {
          if (numberValue(asRecord(error).status) !== 404) throw error
        }
      }
      options.store.cancelCloudUpload(materialId)
      options.store.setCloudStatusForMaterial(materialId, 'not_uploaded')
      emit('cloud-upload-control', { materialId, status: 'canceled' })
      return { ok: true, action, status: status() }
    } catch (error) {
      canceledUploads.delete(materialId)
      pausedUploads.add(materialId)
      const message = sanitizedError(error, '取消云端上传失败，上传任务已保持暂停')
      emit('cloud-upload-control', { materialId, status: 'paused', message })
      return { ok: false, action, message, status: status() }
    }
  }

  function queueCloudCopyDeletion(value: unknown): {
    ok: boolean
    queued: boolean
    message?: string
    status: MaterialCloudStatus
  } {
    const record = asRecord(value)
    const materialId = stringValue(record.materialId || record.material_id).trim()
    const material = options.store.getMaterialCloudFileById(materialId)
    if (!material) return { ok: false, queued: false, message: '素材不存在', status: status() }
    if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
      return {
        ok: false,
        queued: false,
        message: '当前设备没有本地文件，不能删除唯一的云端副本',
        status: status(),
      }
    }
    if (material.cloudStatus !== 'ready') {
      return { ok: false, queued: false, message: '素材云端副本尚未就绪', status: status() }
    }
    const revision = Math.floor(material.cloudRevision || material.revision)
    if (revision < 1) {
      return { ok: false, queued: false, message: '素材云端版本尚未同步', status: status() }
    }
    options.store.queueCloudOperation('delete_cloud_copy', material.materialId, { revision })
    options.store.setCloudStatusForMaterial(material.materialId, 'deleting')
    emit('cloud-queue', { materialId: material.materialId, operation: 'delete_cloud_copy' })
    void processQueue()
    return { ok: true, queued: true, status: status() }
  }

  function queueFolderSync(value: unknown): { queued: boolean; status: MaterialCloudStatus } {
    const record = asRecord(value)
    const folderId = stringValue(record.folderId || record.folder_id).trim()
    if (!folderId || !options.store.getCloudFolderRecord(folderId)) {
      return { queued: false, status: status() }
    }
    options.store.queueCloudOperation('sync_folder', folderId, {})
    void processQueue()
    return { queued: true, status: status() }
  }

  function queueGenerationStatus(value: unknown): { queued: boolean; status: MaterialCloudStatus } {
    const record = asRecord(value)
    const runId = stringValue(record.runId || record.run_id).trim()
    const runStatus = stringValue(record.status).trim()
    if (!/^run_[A-Za-z0-9_-]{5,92}$/.test(runId)) {
      return { queued: false, status: status() }
    }
    if (!['running', 'succeeded', 'failed', 'canceled'].includes(runStatus)) {
      return { queued: false, status: status() }
    }
    const rawStage = stringValue(record.stage).trim()
    const stage = /^[A-Za-z0-9_-]{1,64}$/.test(rawStage)
      ? rawStage
      : runStatus === 'succeeded' ? 'done' : 'running'
    const payload: Record<string, unknown> = {
      status: runStatus,
      stage,
      progress: runStatus === 'succeeded'
        ? 100
        : Math.max(0, Math.min(100, numberValue(record.progress))),
    }
    if (record.currentShotId || record.current_shot_id) {
      payload.current_shot_id = record.currentShotId || record.current_shot_id
    }
    if (record.currentMaterialId || record.current_material_id) {
      payload.current_material_id = record.currentMaterialId || record.current_material_id
    }
    if (runStatus === 'failed') {
      payload.error_code = stringValue(record.errorCode || record.error_code)
        .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'DESKTOP_PROCESS_FAILED'
      payload.error_message = sanitizedError(
        record.errorMessage || record.error_message,
        '本地生成进程执行失败',
      ).slice(0, 2000)
    }
    options.store.queueCloudOperation('update_generation', runId, payload)
    void processQueue()
    return { queued: true, status: status() }
  }

  function queuePolicyUploads(config: JsonRecord): number {
    const platform = asRecord(config.platform_downloads || config.platform)
    const origins: Array<'user_upload' | 'platform_download'> = []
    if (platform.auto_sync_enabled === true) origins.push('platform_download')
    if (env().VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS?.trim() === 'true') origins.push('user_upload')
    let queued = 0
    for (const material of options.store.listCloudUploadCandidates(origins)) {
      const operation = options.store.queueCloudOperation('upload', material.materialId, { policy: true })
      if (['paused', 'canceled'].includes(operation.status)) continue
      queued += 1
    }
    return queued
  }

  function normalizeAnalysisStatus(value: unknown): MaterialCloudFile['analysisStatus'] {
    const statusValue = stringValue(value).toLocaleLowerCase()
    if (statusValue === 'completed' || statusValue === 'ready') return 'ready'
    if (statusValue === 'processing' || statusValue === 'analyzing') return 'analyzing'
    if (statusValue === 'failed') return 'failed'
    return 'pending'
  }

  function normalizeCloudStatus(value: unknown): MaterialCloudFile['cloudStatus'] {
    const statusValue = stringValue(value).toLocaleLowerCase()
    if (['not_uploaded', 'uploading', 'verifying', 'ready', 'deleting', 'failed', 'deleted'].includes(statusValue)) {
      return statusValue as MaterialCloudFile['cloudStatus']
    }
    return 'not_uploaded'
  }

  async function pagedItems(pathname: string): Promise<JsonRecord[]> {
    const items: JsonRecord[] = []
    let cursor = ''
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const separator = pathname.includes('?') ? '&' : '?'
      const response = await api(`${pathname}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      const pageItems = Array.isArray(response.items) ? response.items.map(asRecord) : []
      items.push(...pageItems)
      cursor = stringValue(response.next_cursor)
      if (!response.has_more || !cursor) break
    }
    return items
  }

  async function pullCloudFolders(): Promise<void> {
    const pending: CloudFolderRecord[] = (await pagedItems('/v1/folders')).map((item) => ({
      folderId: stringValue(item.folder_id),
      parentFolderId: stringValue(item.parent_folder_id) || undefined,
      name: stringValue(item.name),
      revision: numberValue(item.revision),
    })).filter((item) => item.folderId && item.name)
    let remaining = pending
    for (let pass = 0; remaining.length && pass <= pending.length; pass += 1) {
      const next: CloudFolderRecord[] = []
      let progressed = false
      for (const folder of remaining) {
        try {
          options.store.upsertCloudFolder(folder)
          progressed = true
        } catch {
          next.push(folder)
        }
      }
      if (!progressed) throw new Error('云端文件夹层级无法解析')
      remaining = next
    }
  }

  async function materialDetails(item: JsonRecord): Promise<JsonRecord> {
    const directHash = stringValue(item.source_sha256 || asRecord(item.asset).source_sha256)
    if (/^[a-f0-9]{64}$/.test(directHash)) return item
    const materialId = stringValue(item.material_id)
    return materialId ? api(`/v1/materials/${encodeURIComponent(materialId)}`) : item
  }

  async function importCloudMaterial(summary: JsonRecord): Promise<void> {
    const item = await materialDetails(summary)
    const asset = asRecord(item.asset)
    const sourceSha256 = stringValue(item.source_sha256 || asset.source_sha256).toLocaleLowerCase()
    const sourceSize = numberValue(item.file_size_bytes || item.source_size || asset.source_size)
    const record: CloudMaterialRecord = {
      materialId: stringValue(item.material_id),
      assetId: stringValue(item.asset_id || asset.asset_id),
      assetVersion: numberValue(item.asset_version || asset.asset_version),
      folderId: stringValue(item.folder_id),
      displayName: stringValue(item.display_name),
      origin: stringValue(item.origin || asset.origin) === 'platform_download' ? 'platform_download' : 'user_upload',
      addedFrom: ['task_download', 'cloud_restore', 'public_library'].includes(stringValue(item.added_from))
        ? stringValue(item.added_from) as CloudMaterialRecord['addedFrom']
        : 'user_import',
      sourceSha256,
      sourceSize,
      mimeType: stringValue(item.mime_type || asset.mime_type || 'video/mp4'),
      analysisStatus: normalizeAnalysisStatus(item.analysis_status),
      analysisError: stringValue(item.analysis_error) || undefined,
      cloudStatus: normalizeCloudStatus(item.cloud_status),
      cloudError: stringValue(item.cloud_error) || undefined,
      revision: numberValue(item.revision),
      publicationStatus: ['publishing', 'public', 'suspended', 'removed'].includes(stringValue(item.publication_status))
        ? stringValue(item.publication_status) as CloudMaterialRecord['publicationStatus']
        : 'private',
      publicationId: stringValue(item.publication_id) || undefined,
      publicationRevision: numberValue(item.publication_revision) || undefined,
      publicationReviewReason: stringValue(item.publication_review_reason) || undefined,
    }
    if (
      !record.materialId
      || !record.assetId
      || record.assetVersion < 1
      || !record.folderId
      || !record.displayName
      || !/^[a-f0-9]{64}$/.test(record.sourceSha256)
      || record.sourceSize <= 0
    ) {
      throw new Error(`云端素材信息不完整，未跳过本次同步：${record.materialId || '未知素材'}`)
    }
    options.store.upsertCloudMaterial(record)
    const local = options.store.getMaterialCloudFileById(record.materialId)
    if (
      local?.localStatus === 'present'
      && local.analysisStatus !== 'ready'
      && local.cloudAnalysisStatus === 'ready'
    ) {
      options.store.queueCloudOperation('restore_analysis', local.materialId, {})
    }
  }

  function reportSyncProgress(phase: string, completed = 0, total = 0): void {
    progress = { phase, completed, total }
    emit('cloud-sync-progress')
  }

  function retryAnalysisTransfer(value: unknown): { ok: boolean; queued?: boolean; message?: string } {
    const record = asRecord(value)
    const materialId = stringValue(record.materialId).trim()
    const direction = record.direction
    if (!apiBase() || !authToken()) return { ok: false, message: '请先登录并连接云素材服务' }
    if (!['upload', 'download'].includes(stringValue(direction))) return { ok: false, message: '分析同步方向无效' }
    const material = options.store.getMaterialCloudFileById(materialId)
    if (!material) return { ok: false, message: '素材不存在，请刷新素材库' }
    if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
      return { ok: false, message: '请先下载或恢复本地视频，再同步已有分析结果' }
    }
    if (direction === 'upload' && material.analysisStatus !== 'ready') {
      return { ok: false, message: '本地尚无有效分析结果，请先完成素材分析' }
    }
    if (direction === 'download' && (material.cloudStatus !== 'ready' || material.cloudAnalysisStatus !== 'ready')) {
      return { ok: false, message: '云端尚无可恢复的分析结果，请先完成云端分析同步' }
    }
    if (direction === 'upload' && material.cloudStatus !== 'ready') {
      return { ok: false, message: '请先完成视频上传，再同步分析结果' }
    }
    options.store.queueCloudOperation(direction === 'download' ? 'restore_analysis' : 'sync_analysis', materialId)
    emit('cloud-analysis-status', { materialId, direction, status: 'queued' })
    requestQueueProcessing()
    return { ok: true, queued: true }
  }

  async function importMaterialBatch(items: JsonRecord[]): Promise<void> {
    const unique = [...new Map(items.map(item => [stringValue(item.material_id), item])).values()]
    let completed = 0
    reportSyncProgress('读取素材详情', completed, unique.length)
    for (let offset = 0; offset < unique.length; offset += 6) {
      // Wait for every request in a batch before advancing or reporting failure.
      const results = await Promise.allSettled(unique.slice(offset, offset + 6).map(async item => {
        try { await importCloudMaterial(item) }
        catch (error) {
          if (numberValue(asRecord(error).status) !== 404) throw error
          options.store.applyCloudDeletion('material', item.material_id, numberValue(item.revision) || 1)
        }
        completed += 1
        reportSyncProgress('读取素材详情', completed, unique.length)
      }))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }

  async function readCloudChanges(cursorValue: number): Promise<{ cursor: number; changes: JsonRecord[] }> {
    let cursor = cursorValue
    const changes: JsonRecord[] = []
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await api(`/v1/sync/changes?cursor=${cursor}&limit=500`)
      if (Array.isArray(response.changes)) changes.push(...response.changes.map(asRecord))
      const next = Math.max(cursor, Math.floor(numberValue(response.next_cursor)))
      if (response.has_more !== true) return { cursor: next, changes }
      if (next <= cursor) throw new Error('云端变化游标未前进，请重试同步')
      cursor = next
    }
    throw new Error('云端变化分页过多，请重试同步')
  }

  async function syncCatalog(): Promise<boolean> {
    const auth = asRecord(options.readAuthState())
    const account = String(asRecord(auth.user).id || auth.agentUserId || authToken())
    // Refresh once after the server's analysis projection correction; later syncs stay incremental.
    const key = `catalog_v4_${createHash('sha256').update(apiBase() + ':' + account).digest('hex')}`
    const saved = options.store.getCloudState(key)
    reportSyncProgress(saved ? '检查云端变化' : '读取首次同步目录')
    const delta = await readCloudChanges(saved ? Number(saved) : 0)
    if (!saved) {
      reportSyncProgress('读取文件夹')
      await pullCloudFolders()
      reportSyncProgress('分页读取素材目录')
      await importMaterialBatch(await pagedItems('/v1/materials?sort=updated_desc'))
    } else {
      const latest = [...new Map(delta.changes.map(change => [
        `${change.entity_type}:${change.entity_id}`, change,
      ])).values()]
      if (latest.some(change => change.entity_type === 'folder' || (
        change.entity_type === 'material' && change.operation !== 'delete'
      ))) {
        reportSyncProgress('更新文件夹')
        await pullCloudFolders()
      }
      const updates = latest.filter(change => change.entity_type === 'material' && change.operation !== 'delete')
      await importMaterialBatch(updates.map(change => ({ material_id: change.entity_id, revision: change.revision })))
      for (const change of latest.filter(change => change.operation === 'delete')) {
        options.store.applyCloudDeletion(change.entity_type, change.entity_id, change.revision)
      }
    }
    // Advance only after all imports succeed; a failed attempt replays safely.
    options.store.setCloudState(key, String(delta.cursor))
    reportSyncProgress('素材目录已更新', progress.total, progress.total)
    return !saved || delta.changes.length > 0
  }
  let cachedPolicy: { key: string; expiresAt: number; value: JsonRecord } | undefined
  async function readSyncPolicy(): Promise<JsonRecord> {
    const account = asRecord(options.readAuthState())
    const key = createHash('sha256').update(apiBase() + ':' + authToken() + ':' + String(asRecord(account.user).id || account.agentUserId || '')).digest('hex')
    if (cachedPolicy?.key === key && cachedPolicy.expiresAt > Date.now()) return cachedPolicy.value
    const value = await api('/v1/material-config')
    cachedPolicy = { key, value, expiresAt: Date.now() + 60_000 }
    return value
  }
  async function syncNow(): Promise<MaterialCloudStatus> {
    if (syncing) return status()
    if (!apiBase() || !authToken()) return status()
    syncing = true
    emit('cloud-sync-started')
    try {
      const results = await Promise.allSettled([readSyncPolicy(), syncCatalog()])
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      const config = (results[0] as PromiseFulfilledResult<JsonRecord>).value
      queuePolicyUploads(config)
      const queueStatus = await processQueue()
      if (queueStatus.lastError) {
        emit('cloud-sync-failed', { message: queueStatus.lastError })
        return { ...status(), syncing: false }
      }
      lastSyncAt = new Date().toISOString()
      options.store.setCloudState('last_sync_at', lastSyncAt)
      lastError = ''
      online = true
      emit('cloud-sync-completed', { catalogChanged: (results[1] as PromiseFulfilledResult<boolean>).value })
      return { ...status(), syncing: false }
    } catch (error) {
      lastError = sanitizedError(error, '云素材同步失败')
      online = false
      emit('cloud-sync-failed', { message: lastError })
      return { ...status(), syncing: false }
    } finally {
      syncing = false
      emit('cloud-sync-settled')
    }
  }

  async function semanticSearch(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const query = stringValue(record.query).trim()
    if (!query) return { ok: false, message: '请输入语义搜索内容', results: [], raw: '' }
    const limit = Math.max(1, Math.min(100, numberValue(record.results || record.limit) || 20))
    const response = await api('/v1/materials/search/semantic', {
      method: 'POST',
      body: {
        query,
        limit,
        ...(record.folderId || record.folder_id ? {
          scope: {
            folder_id: stringValue(record.folderId || record.folder_id),
            include_subfolders: record.includeSubfolders === true || record.include_subfolders === true,
          },
        } : {}),
      },
    })
    const responseItems = Array.isArray(response.results)
      ? response.results
      : Array.isArray(response.items) ? response.items : []
    // A new device may receive vector hits before its material catalog has synced.
    // Fetch the hit metadata directly; never discard it just because the local DB is empty.
    const missingIds = [...new Set(responseItems.map((valueItem) => stringValue(asRecord(valueItem).material_id)))]
      .filter((id) => id && !options.store.getMaterialCloudFileById(id))
    if (missingIds.length) {
      await pullCloudFolders()
      for (const materialId of missingIds) await importCloudMaterial({ material_id: materialId })
    }
    const results = responseItems.flatMap((valueItem, index) => {
      const item = asRecord(valueItem)
      const materialId = stringValue(item.material_id)
      const material = options.store.getMaterialCloudFileById(materialId)
      if (!material) return []
      return [{
        rank: numberValue(item.rank) || index + 1,
        score: numberValue(item.score),
        name: material.displayName,
        path: material.localPath,
        start: stringValue(item.start || item.start_time),
        end: stringValue(item.end || item.end_time),
        text: stringValue(item.text || item.caption || material.displayName),
        localPath: material.localPath,
        localUrl: material.localStatus === 'present' ? createLocalMediaUrl(material.localPath) : '',
        localSize: material.sourceSize,
        localMtime: 0,
        materialId: material.materialId,
        assetId: material.assetId,
        assetVersion: material.assetVersion,
        sourceSha256: material.sourceSha256,
        localStatus: material.localStatus,
        analysisStatus: material.cloudAnalysisStatus === 'ready' ? 'ready' : material.analysisStatus,
        analysisError: material.analysisError,
        cloudStatus: material.cloudStatus,
      }]
    })
    return { ok: true, message: '', results, raw: '', source: 'cloud' }
  }

  async function listPublicMaterials(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const keyword = stringValue(record.keyword).trim()
    const limit = Math.max(1, Math.min(100, Math.floor(numberValue(record.limit) || 50)))
    try {
      const response = await api(
        `/v1/public-materials?limit=${limit}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`,
      )
      return {
        ok: true,
        items: Array.isArray(response.items) ? response.items : [],
        hasMore: response.has_more === true,
        nextCursor: stringValue(response.next_cursor) || undefined,
      }
    } catch (error) {
      return { ok: false, items: [], message: sanitizedError(error, '读取公共素材失败') }
    }
  }

  async function addPublicMaterial(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const publicationId = stringValue(record.publicationId || record.publication_id).trim()
    const folderId = stringValue(record.folderId || record.folder_id).trim()
    if (!publicationId || !folderId) return { ok: false, message: '公共素材或目标文件夹无效' }
    try {
      const response = await api(
        `/v1/public-materials/${encodeURIComponent(publicationId)}/add`,
        {
          method: 'POST',
          idempotencyKey: stableOperationKey('public-add', options.deviceId, publicationId, folderId),
          body: { folder_id: folderId },
        },
      )
      await syncNow()
      return { ok: true, ...response }
    } catch (error) {
      return { ok: false, message: sanitizedError(error, '添加公共素材失败') }
    }
  }

  async function reportPublicMaterial(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const publicationId = stringValue(record.publicationId || record.publication_id).trim()
    const category = stringValue(record.category).trim()
    const description = stringValue(record.description).trim()
    if (!publicationId) return { ok: false, message: '公共素材无效' }
    if (!['copyright', 'privacy', 'harmful', 'other'].includes(category)) {
      return { ok: false, message: '请选择举报类型' }
    }
    if (description.length < 10 || description.length > 2000) {
      return { ok: false, message: '举报说明需填写 10 到 2000 个字符' }
    }
    try {
      const response = await api(
        `/v1/public-materials/${encodeURIComponent(publicationId)}/reports`,
        {
          method: 'POST',
          idempotencyKey: stableOperationKey(
            'public-report', options.deviceId, publicationId, category, description,
          ),
          body: { category, description },
        },
      )
      return { ok: true, ...response }
    } catch (error) {
      return { ok: false, message: sanitizedError(error, '提交举报失败') }
    }
  }

  async function publishMaterial(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const materialId = stringValue(record.materialId || record.material_id).trim()
    const material = options.store.getMaterialCloudFileById(materialId)
    if (!material) return { ok: false, message: '素材不存在' }
    if (material.cloudStatus !== 'ready') return { ok: false, message: '请先完成云端备份再申请公开' }
    if (material.cloudAnalysisStatus !== 'ready') return { ok: false, message: '请先完成素材分析同步再申请公开' }
    try {
      const config = await api('/v1/material-config')
      const consentVersion = stringValue(asRecord(config.publications).consent_version)
      if (!consentVersion) throw new Error('云素材服务没有返回公开授权声明版本')
      const response = await api(`/v1/materials/${encodeURIComponent(materialId)}/publications`, {
        method: 'POST',
        idempotencyKey: stableOperationKey(
          'publication-submit', options.deviceId, materialId, material.cloudRevision, consentVersion,
        ),
        body: {
          revision: material.cloudRevision,
          consent_version: consentVersion,
          rights_confirmed: true,
        },
      })
      await syncNow()
      return { ok: true, ...response }
    } catch (error) {
      return { ok: false, message: sanitizedError(error, '申请公开素材失败') }
    }
  }

  async function withdrawPublication(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const materialId = stringValue(record.materialId || record.material_id).trim()
    const reason = stringValue(record.reason).trim()
    const material = options.store.getMaterialCloudFileById(materialId)
    if (!material?.publicationId || !material.publicationRevision) {
      return { ok: false, message: '素材没有可取消的公开申请' }
    }
    try {
      const response = await api(
        `/v1/publications/${encodeURIComponent(material.publicationId)}`,
        {
          method: 'DELETE',
          idempotencyKey: stableOperationKey(
            'publication-withdraw', options.deviceId, material.publicationId, material.publicationRevision,
          ),
          body: { revision: material.publicationRevision, reason },
        },
      )
      await syncNow()
      return { ok: true, ...response }
    } catch (error) {
      return { ok: false, message: sanitizedError(error, '取消公开素材失败') }
    }
  }

  async function resolveMaterialSelection(value: unknown): Promise<JsonRecord> {
    const record = asRecord(value)
    const materialIds = Array.isArray(record.materialIds || record.material_ids)
      ? (record.materialIds || record.material_ids) as unknown[]
      : []
    const normalized = [...new Set(materialIds.map((item) => stringValue(item).trim()).filter(Boolean))]
    if (!normalized.length) return { ok: true, items: [], unavailable: [], source: 'local' }
    const remoteIds = normalized.filter((id) => {
      const material = options.store.getMaterialCloudFileById(id)
      return !material || material.cloudStatus === 'ready' || material.localStatus !== 'present'
        || !fs.existsSync(material.localPath)
    })
    if (!remoteIds.length) return { ok: true, items: [], unavailable: [], source: 'local' }
    if (!apiBase()) return { ok: true, items: [], unavailable: [], source: 'local' }
    if (!authToken()) return { ok: false, message: '登录已失效，请重新登录后选择云端素材' }
    try {
      const response = await api('/v1/selections/resolve', {
        method: 'POST',
        body: { material_ids: remoteIds },
      })
      const unavailable = Array.isArray(response.unavailable) ? response.unavailable : []
      return {
        ok: unavailable.length === 0,
        items: Array.isArray(response.items) ? response.items : [],
        unavailable,
        source: 'cloud',
        message: unavailable.length ? '部分素材已删除或当前账号无权访问，请刷新素材库后重新选择' : '',
      }
    } catch (error) {
      return { ok: false, message: sanitizedError(error, '素材权限校验失败') }
    }
  }

  async function downloadMaterial(value: unknown): Promise<{ ok: boolean; message?: string; path?: string }> {
    const record = asRecord(value)
    const materialId = stringValue(record.materialId || record.material_id).trim()
    const material = options.store.getMaterialCloudFileById(materialId)
    if (!material) return { ok: false, message: '素材不存在' }
    if (material.localStatus === 'present' && fs.existsSync(material.localPath)) {
      if (material.analysisStatus !== 'ready' && material.cloudAnalysisStatus === 'ready') {
        try {
          await restoreMaterialAnalysis(material)
        } catch (error) {
          options.store.queueCloudOperation('restore_analysis', material.materialId, {})
          return {
            ok: true,
            path: material.localPath,
            message: `视频已在本地，分析索引将在后台恢复：${sanitizedError(error)}`,
          }
        }
      }
      return { ok: true, path: material.localPath }
    }
    if (material.cloudStatus !== 'ready') return { ok: false, message: '素材云端文件尚未就绪' }
    try {
      const source = options.store.getCloudDownloadSource?.(material.materialId) || material
      const session = await api(`/v1/materials/${encodeURIComponent(source.materialId)}/download-session`, {
        method: 'POST',
        idempotencyKey: `download-${options.deviceId}-${source.materialId}`,
      })
      const sessionId = stringValue(session.download_session_id || session.id)
      const expectedSize = numberValue(session.file_size_bytes)
      const expectedHash = stringValue(session.source_sha256).toLocaleLowerCase()
      if (!sessionId || expectedSize !== material.sourceSize || expectedHash !== material.sourceSha256) {
        throw new Error('云素材下载授权与素材身份不一致')
      }
      ensureDir(path.dirname(material.localPath))
      const temporaryPath = `${material.localPath}.download.part`
      let offset = fs.existsSync(temporaryPath) ? fs.statSync(temporaryPath).size : 0
      if (offset > expectedSize || session.range_supported === false) {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
        offset = 0
      }
      let downloadedBytes = offset
      let attemptStartedBytes = offset
      let attemptStartedAt = Date.now()
      let lastProgressAt = 0
      const saveSession = (statusValue: string, error = '') => options.store.saveTransferSession({
        sessionId,
        direction: 'download',
        materialId: material.materialId,
        status: statusValue,
        bytesTransferred: downloadedBytes,
        totalBytes: expectedSize,
        partSize: 0,
        completedParts: [],
        tempRelativePath: temporaryPath,
        lastError: error || undefined,
      })
      const reportProgress = (bytesValue: number, force = false) => {
        downloadedBytes = Math.max(0, Math.min(expectedSize, bytesValue))
        const timestamp = Date.now()
        if (!force && timestamp - lastProgressAt < 250) return
        lastProgressAt = timestamp
        saveSession('downloading')
        emit('cloud-progress', {
          materialId: material.materialId,
          direction: 'download',
          bytesTransferred: downloadedBytes,
          totalBytes: expectedSize,
          speedBytesPerSecond: transferSpeedBytesPerSecond(
            attemptStartedBytes,
            downloadedBytes,
            attemptStartedAt,
            timestamp,
          ),
        })
      }
      saveSession('downloading')
      emit('cloud-status', {
        materialId: material.materialId,
        direction: 'download',
        status: 'downloading',
      })
      reportProgress(downloadedBytes, true)
      try {
        try {
          await downloadFile(
            session.url,
            temporaryPath,
            offset,
            expectedSize,
            (bytes) => reportProgress(bytes),
            options.transferAbortSignal,
          )
        } catch (error) {
          if (asRecord(error).restartDownload === true) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
            offset = 0
            downloadedBytes = 0
            attemptStartedBytes = 0
            attemptStartedAt = Date.now()
            reportProgress(0, true)
            await downloadFile(
              session.url,
              temporaryPath,
              0,
              expectedSize,
              (bytes) => reportProgress(bytes),
              options.transferAbortSignal,
            )
          } else {
            throw error
          }
        }
        if (options.isSessionActive?.() === false) throw new Error('账号已切换，素材下载已停止')
        downloadedBytes = fs.existsSync(temporaryPath) ? fs.statSync(temporaryPath).size : downloadedBytes
        reportProgress(downloadedBytes, true)
        saveSession('verifying')
        emit('cloud-status', {
          materialId: material.materialId,
          direction: 'download',
          status: 'verifying',
        })
        const downloadedStat = fs.statSync(temporaryPath)
        if (downloadedStat.size !== expectedSize || computeSha256(temporaryPath) !== expectedHash) {
          fs.unlinkSync(temporaryPath)
          downloadedBytes = 0
          throw new Error('下载素材 SHA-256 或文件大小校验失败，无效临时文件已清理')
        }
        const backupPath = `${material.localPath}.damaged-${Date.now()}`
        if (fs.existsSync(material.localPath)) fs.renameSync(material.localPath, backupPath)
        try {
          fs.renameSync(temporaryPath, material.localPath)
        } catch (error) {
          if (fs.existsSync(backupPath)) fs.renameSync(backupPath, material.localPath)
          throw error
        }
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath)
        options.store.completeCloudDownload(material.materialId, material.localPath, expectedHash, expectedSize)
        downloadedBytes = expectedSize
        saveSession('ready')
      } catch (error) {
        if (fs.existsSync(temporaryPath)) downloadedBytes = fs.statSync(temporaryPath).size
        saveSession('failed', sanitizedError(error, '下载云端素材失败'))
        throw error
      }
      emit('cloud-status', {
        materialId: material.materialId,
        path: material.localPath,
        direction: 'download',
        status: 'ready',
      })
      const restored = options.store.getMaterialCloudFileById(material.materialId)
      if (restored?.cloudAnalysisStatus === 'ready' && restored.analysisStatus !== 'ready') {
        try {
          await restoreMaterialAnalysis(restored)
        } catch (error) {
          options.store.queueCloudOperation('restore_analysis', material.materialId, {})
          return {
            ok: true,
            path: material.localPath,
            message: `视频已下载，分析索引将在后台恢复：${sanitizedError(error)}`,
          }
        }
      }
      return { ok: true, path: material.localPath }
    } catch (error) {
      const message = sanitizedError(error, '下载云端素材失败')
      emit('cloud-status', { materialId: material.materialId, direction: 'download', status: 'failed', message })
      return { ok: false, message }
    }
  }

  async function prepareGenerationManifest(value: unknown): Promise<unknown> {
    const generationContext = materialSyncContext()
    const input = asRecord(value)
    const generationOptions = {
      taskId: stringValue(input.taskId),
      taskRevision: numberValue(input.taskRevision),
      resumeRunPath: stringValue(input.resumeRunPath) || undefined,
      shots: Array.isArray(input.shots) ? input.shots as PrepareGenerationManifestOptions['shots'] : [],
    }
    if (generationOptions.resumeRunPath && !options.store.resumeMaterialShots) throw new Error('当前素材服务不支持已暂存素材续跑，请更新后重试')
    const resumed = new Map((options.store.resumeMaterialShots?.(generationOptions) || []).map(shot => [shot.shot_id, shot]))
    const freshOptions = { ...generationOptions, shots: generationOptions.shots.filter(shot => !resumed.has(stringValue(shot.shot_id))) }
    const materialIds = [...new Set(options.store.materialIdsForGeneration(freshOptions))]
    for (const materialId of materialIds) {
      const material = options.store.getMaterialCloudFileById(materialId)
      if (!material) throw new Error(`素材不存在或无权访问：${materialId}`)
      if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
        const downloaded = await downloadMaterial({ materialId })
        if (!downloaded.ok) throw new Error(downloaded.message || `素材下载失败：${materialId}`)
      }
    }
    assertMaterialSyncContext(generationContext)
    if (!apiBase()) return options.store.prepareGenerationManifest(generationOptions)
    if (!authToken()) throw new Error('登录已失效，请重新登录后生成视频')
    const cloudFolderIds = new Map<string, string>()
    // Each task waits for its own metadata acknowledgements, including when the outbox is busy.
    // Settle the whole batch before failing so a retry cannot overlap abandoned registrations.
    for (let offset = 0; offset < materialIds.length; offset += QUEUE_BATCH_SIZE) {
      assertMaterialSyncContext(generationContext)
      const registrations = await Promise.allSettled(materialIds.slice(offset, offset + QUEUE_BATCH_SIZE).map(async materialId => {
        const material = options.store.getMaterialCloudFileById(materialId)
        if (!material) throw new Error(`素材不存在或无权访问：${materialId}`)
        try {
          const registeredFolders = await syncMaterialMetadata(material)
          for (const [localId, cloudId] of registeredFolders) {
            const previous = cloudFolderIds.get(localId)
            if (previous && previous !== cloudId) throw new Error('素材文件夹在准备期间发生变化，请重新准备素材')
            cloudFolderIds.set(localId, cloudId)
          }
        } catch (error) {
          const label = material.displayName ? `“${material.displayName}”（${materialId}）` : materialId
          throw new Error(`素材${label}登记失败：${sanitizedError(error)}。请重试素材准备。`, { cause: error })
        }
      }))
      const failed = registrations.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }

    const expandedBindings = generationOptions.shots.reduce((total, shot) => total + (resumed.get(stringValue(shot.shot_id))?.materials.length
      ?? (Array.isArray(shot.material_bindings) ? shot.material_bindings.length : 0)), 0)
    const preserveResumeScopes = new Set([...resumed.values()].filter(shot => shot.materials.length > 100 || expandedBindings > 500).map(shot => shot.shot_id))
    // Large prior folder scopes must remain folder requests, not hundreds of direct bindings.
    // Resolve their existing cloud identities without reopening or downloading the source files.
    for (const shotId of preserveResumeScopes) {
      const original = generationOptions.shots.find(shot => stringValue(shot.shot_id) === shotId)
      const needed = new Set((Array.isArray(original?.material_bindings) ? original.material_bindings.map(asRecord) : [])
        .filter(binding => binding.binding_type === 'folder').map(binding => stringValue(binding.folder_id)))
      for (const item of resumed.get(shotId)?.materials || []) {
        if ([...needed].every(id => cloudFolderIds.has(id))) break
        const chain = options.store.folderChainForMaterial(item.material_id)
        if (!chain.some(folder => needed.has(folder.folderId) && !cloudFolderIds.has(folder.folderId))) continue
        const resolved = await resolveUploadFolderChain(chain)
        assertMaterialSyncContext(generationContext)
        chain.forEach((folder, index) => cloudFolderIds.set(folder.folderId, resolved.folders[index].folderId))
      }
    }
    const originalShotByCloudId = new Map<string, string>()
    const requestShots = generationOptions.shots.map((shot) => {
      const record = asRecord(shot)
      const originalShotId = stringValue(record.shot_id).trim()
      if (!originalShotId) throw new Error('分镜缺少 shot_id')
      const shotId = cloudOpaqueId('shot', originalShotId)
      originalShotByCloudId.set(shotId, originalShotId)
      const pinned = resumed.get(originalShotId)
      const rawBindings: JsonRecord[] = pinned && !preserveResumeScopes.has(originalShotId) ? pinned.materials.map(item => ({ binding_type: 'material', material_id: item.material_id })) : Array.isArray(record.material_bindings)
        ? record.material_bindings.map(asRecord)
        : []
      const materialBindings = rawBindings.map((binding) => {
        if (stringValue(binding.binding_type) === 'material') {
          const materialId = stringValue(binding.material_id).trim()
          if (!materialId) throw new Error(`分镜 ${originalShotId} 包含无效素材绑定`)
          return { binding_type: 'material', material_id: materialId }
        }
        if (stringValue(binding.binding_type) === 'folder') {
          const folderId = stringValue(binding.folder_id).trim()
          if (!folderId) throw new Error(`分镜 ${originalShotId} 包含无效文件夹绑定`)
          return {
            binding_type: 'folder',
            // Registration reuses an existing cloud folder by hierarchy/name. Keep
            // validation on that same identity without changing this shot's scope.
            folder_id: cloudFolderIds.get(folderId) || folderId,
            include_subfolders: binding.include_subfolders === true,
          }
        }
        throw new Error(`分镜 ${originalShotId} 包含不支持的素材绑定`)
      })
      return {
        shot_id: shotId,
        download_material: record.download_material !== false,
        material_bindings: materialBindings,
      }
    })
    const validationRequest = {
      shots: requestShots,
      require_cloud_ready: false,
      require_analysis_ready: false,
    }
    assertMaterialSyncContext(generationContext)
    const validation = await api('/v1/shot-material-validations', {
      method: 'POST',
      body: validationRequest,
    })
    if (validation.valid !== true) {
      const shots = Array.isArray(validation.shots) ? validation.shots.map(asRecord) : []
      const blockers = shots.flatMap((shot) => {
        const shotId = originalShotByCloudId.get(stringValue(shot.shot_id)) || stringValue(shot.shot_id)
        const issues = Array.isArray(shot.issues) ? shot.issues.map(asRecord) : []
        return issues
          .filter((issue) => stringValue(issue.severity) === 'blocker')
          .map((issue) => `${shotId}：${stringValue(issue.message) || '素材不可用'}`)
      })
      throw new Error(blockers.slice(0, 5).join('；') || '分镜素材校验未通过')
    }
    assertMaterialSyncContext(generationContext)
    const cloudTaskId = cloudOpaqueId('task', generationOptions.taskId)
    const createRequest = {
      task_id: cloudTaskId,
      task_revision: Math.floor(generationOptions.taskRevision),
      ...validationRequest,
    }
    if (createRequest.task_revision < 1) throw new Error('请先保存当前分镜再开始生成')
    const created = await api('/v1/generation-runs', {
      method: 'POST',
      idempotencyKey: stableOperationKey(
        'generation-run', cloudTaskId, createRequest.task_revision, JSON.stringify(requestShots),
      ),
      body: createRequest,
    })
    assertMaterialSyncContext(generationContext)
    const runId = stringValue(created.run_id)
    if (!runId) throw new Error('云素材服务没有返回生成运行标识')
    const frozen = await api(
      `/v1/generation-runs/${encodeURIComponent(runId)}/material-manifest`,
    )
    assertMaterialSyncContext(generationContext)
    const frozenShots = Array.isArray(frozen.shots) ? frozen.shots.map(asRecord) : []
    if (generationOptions.resumeRunPath && (frozenShots.length !== requestShots.length
      || new Set(frozenShots.map(shot => stringValue(shot.shot_id))).size !== requestShots.length
      || frozenShots.some(shot => !originalShotByCloudId.has(stringValue(shot.shot_id))))) throw new Error('云端续跑清单的分镜与当前任务不一致')
    for (const shot of frozenShots) {
      const materials = Array.isArray(shot.materials) ? shot.materials.map(asRecord) : []
      const pinned = resumed.get(originalShotByCloudId.get(stringValue(shot.shot_id)) || '')
      if (pinned) {
        const exact = materials.length === pinned.materials.length && new Set(materials.map(item => stringValue(item.material_id))).size === materials.length && materials.every(item => pinned.materials.some(previous => sameFrozenMaterial(previous, {
          material_id: stringValue(item.material_id), asset_id: stringValue(item.asset_id), asset_version: numberValue(item.asset_version), source_sha256: stringValue(item.source_sha256),
        })))
        if (!exact) throw new Error('云端素材版本与原任务冻结记录不一致，请重新准备对应分镜素材')
        continue
      }
      for (const item of materials) {
        const materialId = stringValue(item.material_id)
        const material = options.store.getMaterialCloudFileById(materialId)
        if (!material) throw new Error(`云端生成清单包含当前设备未知的素材：${materialId}`)
        if (material.localStatus !== 'present' || !fs.existsSync(material.localPath)) {
          const downloaded = await downloadMaterial({ materialId })
          if (!downloaded.ok) throw new Error(downloaded.message || `素材下载失败：${materialId}`)
        }
      }
    }
    const snapshot: FrozenGenerationManifestInput = {
      runId,
      taskId: generationOptions.taskId,
      taskRevision: createRequest.task_revision,
      ...(generationOptions.resumeRunPath ? { resumeOptions: generationOptions } : {}),
      shots: frozenShots.map((shot) => ({
        shot_id: originalShotByCloudId.get(stringValue(shot.shot_id)) || stringValue(shot.shot_id),
        materials: (Array.isArray(shot.materials) ? shot.materials.map(asRecord) : []).map((item) => ({
          material_id: stringValue(item.material_id),
          asset_id: stringValue(item.asset_id),
          asset_version: numberValue(item.asset_version),
          source_sha256: stringValue(item.source_sha256),
        })),
      })),
    }
    assertMaterialSyncContext(generationContext)
    return options.store.prepareGenerationManifestFromSnapshot(snapshot)
  }

  function start(): void {
    if (queueTimer || syncTimer) return
    queueTimer = setInterval(() => { void processQueue() }, 15_000)
    syncTimer = setInterval(() => { void syncNow() }, 5 * 60_000)
    queueTimer.unref?.()
    syncTimer.unref?.()
    void processQueue()
    void syncNow()
  }

  function stop(): void {
    if (queueTimer) clearInterval(queueTimer)
    if (syncTimer) clearInterval(syncTimer)
    queueTimer = null
    syncTimer = null
  }

  return {
    addPublicMaterial,
    controlUpload,
    downloadMaterial,
    listPublicMaterials,
    prepareGenerationManifest,
    processQueue,
    wakeQueue: requestQueueProcessing,
    queueFolderSync,
    queueGenerationStatus,
    queueCloudCopyDeletion,
    queueUploads,
    retryAnalysisTransfer,
    reportPublicMaterial,
    resolveMaterialSelection,
    semanticSearch,
    publishMaterial,
    start,
    status,
    stop,
    syncNow,
    withdrawPublication,
  }
}

export {
  createMaterialCloudService,
  downloadToFile,
  normalizeApiBase,
  chromiumUploadHeaders,
  downloadContentRangeMatches,
  transferSpeedBytesPerSecond,
  uploadFileRangeWithFetch,
  type MaterialCloudStatus,
}
