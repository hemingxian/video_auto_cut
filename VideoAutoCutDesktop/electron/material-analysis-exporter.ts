import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { VIDEO_EXTENSIONS } from './file-extensions.js'
import { canonicalAnalysisJson, parseAnalysisProvenance } from './analysis-provenance.js'
import type { SentrySearchPaths } from './materials-types.js'
import { runCapture as captureProcess } from './process-runner.js'
import { sentryFilePath, sentryProcessEnv } from './sentry-path.js'
import { asRecord, numberValue, stringValue, type MutableEnv } from './types.js'

interface MaterialAnalysisChunk {
  chunk_id: string
  start_ms: number
  end_ms: number
  caption: string
  embedding: number[]
}

interface MaterialAnalysisExport {
  analysis_provenance?: Record<string, unknown>
  analysis_profile_id: string
  embedding_backend: 'qwen-cloud'
  model_name: string
  model_version: string
  dimension: number
  result_schema_version: number
  chunks: MaterialAnalysisChunk[]
}

interface MaterialAnalysisDownload extends MaterialAnalysisExport {
  material_id: string
  asset_id: string
  asset_version: number
  source_sha256: string
  file_size_bytes: number
  analysis_id: string
}

interface MaterialAnalysisExporterOptions {
  dataRoot: string
  getSentrySearchPaths: () => SentrySearchPaths
  createVideoAutoEnv: (extra?: MutableEnv) => NodeJS.ProcessEnv
  runCapture?: typeof captureProcess
}

function analysisProfileId(result: Omit<MaterialAnalysisExport, 'analysis_profile_id'>): string {
  const identity = [
    result.embedding_backend,
    result.model_name,
    result.model_version,
    result.dimension,
    result.result_schema_version,
  ].join(':') + (result.analysis_provenance
    ? ':' + canonicalAnalysisJson({ analysis_profile: result.analysis_provenance.analysis_profile,
      normalization_profile: asRecord(result.analysis_provenance.source_identity).normalization_profile ?? null }) : '')
  return `profile_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

function parseAnalysisExport(value: unknown): MaterialAnalysisExport {
  const record = asRecord(value)
  const embeddingBackend = stringValue(record.embedding_backend)
  if (embeddingBackend !== 'qwen-cloud') throw new Error('分析结果不是Qwen云模型生成')
  const dimension = Math.floor(numberValue(record.dimension))
  if (dimension <= 0 || dimension > 4096) throw new Error('分析结果向量维度无效')
  const resultSchemaVersion = Math.floor(numberValue(record.result_schema_version))
  if (resultSchemaVersion < 1 || resultSchemaVersion > 100) throw new Error('分析结果版本无效')
  const modelName = stringValue(record.model_name).trim()
  const modelVersion = stringValue(record.model_version).trim()
  if (!modelName || !modelVersion) throw new Error('分析结果缺少Qwen模型信息')
  const provenance = parseAnalysisProvenance(record.analysis_provenance)
  if (provenance) {
    const profile = asRecord(provenance.analysis_profile)
    if (profile.model !== modelName || profile.dimensions !== dimension) {
      throw new Error('分析参数与模型身份不一致')
    }
  }
  const sourceChunks = Array.isArray(record.chunks) ? record.chunks : []
  if (!sourceChunks.length || sourceChunks.length > 10_000) throw new Error('分析结果分段数量无效')
  const seen = new Set<string>()
  const chunks = sourceChunks.map((value) => {
    const chunk = asRecord(value)
    const chunkId = stringValue(chunk.chunk_id).trim()
    const startMs = Math.floor(numberValue(chunk.start_ms))
    const endMs = Math.floor(numberValue(chunk.end_ms))
    const embedding = Array.isArray(chunk.embedding)
      ? chunk.embedding.map((item) => Number(item))
      : []
    if (!/^[A-Za-z0-9_-]{5,96}$/.test(chunkId) || seen.has(chunkId)) {
      throw new Error('分析结果包含无效或重复的分段ID')
    }
    if (startMs < 0 || endMs <= startMs) throw new Error('分析结果分段时间范围无效')
    if (embedding.length !== dimension || embedding.some((item) => !Number.isFinite(item))) {
      throw new Error('分析结果包含无效向量')
    }
    seen.add(chunkId)
    return {
      chunk_id: chunkId,
      start_ms: startMs,
      end_ms: endMs,
      caption: stringValue(chunk.caption).slice(0, 10_000),
      embedding,
    }
  })
  const result = {
    ...(provenance ? { analysis_provenance: provenance } : {}),
    embedding_backend: embeddingBackend,
    model_name: modelName,
    model_version: modelVersion,
    dimension,
    result_schema_version: resultSchemaVersion,
    chunks,
  } satisfies Omit<MaterialAnalysisExport, 'analysis_profile_id'>
  return { analysis_profile_id: analysisProfileId(result), ...result }
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

function parseAnalysisDownload(value: unknown): MaterialAnalysisDownload {
  const record = asRecord(value)
  const analysis = parseAnalysisExport(record)
  const result = {
    ...analysis,
    material_id: stringValue(record.material_id).trim(),
    asset_id: stringValue(record.asset_id).trim(),
    asset_version: Math.floor(numberValue(record.asset_version)),
    source_sha256: stringValue(record.source_sha256).toLocaleLowerCase(),
    file_size_bytes: Math.floor(numberValue(record.file_size_bytes)),
    analysis_id: stringValue(record.analysis_id).trim(),
  }
  if (
    !/^[A-Za-z0-9_-]{5,96}$/.test(result.material_id)
    || !/^[A-Za-z0-9_-]{5,96}$/.test(result.asset_id)
    || !/^[A-Za-z0-9_-]{5,200}$/.test(result.analysis_id)
    || result.asset_version < 1
    || !/^[a-f0-9]{64}$/.test(result.source_sha256)
    || result.file_size_bytes <= 0
  ) {
    throw new Error('云端分析结果缺少有效的素材身份')
  }
  if (result.analysis_provenance) {
    const identity = asRecord(result.analysis_provenance.source_identity)
    if (identity.source_sha256 !== result.source_sha256 || identity.source_size !== result.file_size_bytes) {
      throw new Error('云端分析参数与素材内容身份不一致')
    }
  }
  return result
}

function createMaterialAnalysisExporter(options: MaterialAnalysisExporterOptions) {
  const runCapture = options.runCapture || captureProcess
  function analysisSourceCandidates(filePath: string): string[] {
    const sourcePath = path.resolve(filePath)
    const sourceDirectory = path.dirname(sourcePath)
    const indexDirectory = path.join(sourceDirectory, '_indexed_h264')
    if (!fs.existsSync(indexDirectory)) return [sourcePath]
    try {
      const sourceFiles = fs.readdirSync(sourceDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile()
          && !entry.isSymbolicLink()
          && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase()))
        .map((entry) => path.join(sourceDirectory, entry.name))
        .sort()
      const indexedFiles = fs.readdirSync(indexDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile()
          && !entry.isSymbolicLink()
          && VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase()))
        .map((entry) => path.join(indexDirectory, entry.name))
        .sort()
      const sourceStem = path.parse(sourcePath).name.toLocaleLowerCase()
      const byStem = indexedFiles.filter((candidate) => (
        path.parse(candidate).name.replace(/^\d+_/, '').toLocaleLowerCase() === sourceStem
      ))
      const sourceIndex = sourceFiles.findIndex((candidate) => path.resolve(candidate) === sourcePath)
      const bySequence = sourceIndex < 0
        ? []
        : indexedFiles.filter((candidate) => path.basename(candidate)
          .startsWith(`${String(sourceIndex + 1).padStart(3, '0')}_`))
      return Array.from(new Set([sourcePath, ...byStem, ...bySequence]))
    } catch {
      return [sourcePath]
    }
  }

  async function exportForFile(filePath: string, signal?: AbortSignal): Promise<MaterialAnalysisExport> {
    signal?.throwIfAborted()
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error('待同步分析结果的本地素材不存在')
    }
    const paths = options.getSentrySearchPaths()
    let command: string
    let commandPrefix: string[] = []
    if (fs.existsSync(paths.exe)) {
      command = paths.exe
    } else if (fs.existsSync(paths.python) && fs.existsSync(paths.entry)) {
      command = paths.python
      commandPrefix = [sentryFilePath(paths.entry)]
    } else {
      throw new Error('未找到素材分析运行环境')
    }

    let lastError = '没有找到该素材对应的Qwen分析结果'
    let sourceSha256 = ''
    const sourceSize = fs.statSync(filePath).size
    for (const sourcePath of analysisSourceCandidates(filePath)) {
      signal?.throwIfAborted()
      const output = await runCapture(command, [
        ...commandPrefix,
        'export-analysis',
        sentryFilePath(sourcePath),
        '--backend',
        'qwen-cloud',
      ], {
        cwd: options.dataRoot,
        env: sentryProcessEnv(options.createVideoAutoEnv()),
        signal,
      })
      signal?.throwIfAborted()
      if (output.code !== 0) {
        lastError = stringValue(output.stderr || output.stdout || lastError).slice(0, 1000)
        continue
      }
      try {
        const result = parseAnalysisExport(JSON.parse(output.stdout))
        if (result.analysis_provenance) {
          sourceSha256 ||= computeSha256(filePath)
          const identity = asRecord(result.analysis_provenance.source_identity)
          if (identity.source_sha256 !== sourceSha256 || identity.source_size !== sourceSize) {
            lastError = '分析结果与请求同步的素材内容不一致'
            continue
          }
        }
        return result
      } catch {
        throw new Error('Qwen分析结果导出格式无效')
      }
    }
    throw new Error(lastError)
  }

  async function hasForFile(filePath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await exportForFile(filePath, signal)
      return true
    } catch {
      return false
    }
  }

  async function importForFile(filePath: string, value: unknown, signal?: AbortSignal): Promise<MaterialAnalysisDownload> {
    signal?.throwIfAborted()
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error('待恢复分析结果的本地素材不存在')
    }
    const result = parseAnalysisDownload(value)
    const stat = fs.statSync(filePath)
    if (stat.size !== result.file_size_bytes || computeSha256(filePath) !== result.source_sha256) {
      throw new Error('云端分析结果与本地素材内容不一致')
    }
    const paths = options.getSentrySearchPaths()
    let command: string
    let commandPrefix: string[] = []
    if (fs.existsSync(paths.exe)) {
      command = paths.exe
    } else if (fs.existsSync(paths.python) && fs.existsSync(paths.entry)) {
      command = paths.python
      commandPrefix = [sentryFilePath(paths.entry)]
    } else {
      throw new Error('未找到素材分析运行环境')
    }

    const tempDirectory = path.join(options.dataRoot, 'video', 'temp', 'analysis-restore')
    fs.mkdirSync(tempDirectory, { recursive: true })
    const analysisFile = path.join(tempDirectory, `${randomUUID()}.json`)
    try {
      fs.writeFileSync(analysisFile, JSON.stringify(result), { encoding: 'utf8', mode: 0o600 })
      const output = await runCapture(command, [
        ...commandPrefix,
        'import-analysis',
        sentryFilePath(filePath),
        sentryFilePath(analysisFile),
        '--backend',
        'qwen-cloud',
        '--model',
        result.model_name,
      ], {
        cwd: options.dataRoot,
        env: sentryProcessEnv(options.createVideoAutoEnv()),
        signal,
      })
      signal?.throwIfAborted()
      if (output.code !== 0) {
        throw new Error(stringValue(output.stderr || output.stdout || '导入云端Qwen分析结果失败').slice(0, 1000))
      }
      return result
    } finally {
      try {
        fs.unlinkSync(analysisFile)
      } catch {
        // The next startup can safely remove an abandoned restore file.
      }
    }
  }

  return { exportForFile, hasForFile, importForFile }
}

export {
  createMaterialAnalysisExporter,
  parseAnalysisExport,
  parseAnalysisDownload,
  type MaterialAnalysisExport,
  type MaterialAnalysisDownload,
}
