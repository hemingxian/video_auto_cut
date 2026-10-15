import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createAccountService } from '../dist-electron/account-service.js'
import { getOrCreateDeviceId } from '../dist-electron/device-identity.js'
import { createMaterialAnalysisExporter } from '../dist-electron/material-analysis-exporter.js'
import { createMaterialCloudService } from '../dist-electron/material-cloud-service.js'
import { createMaterialLocalStore } from '../dist-electron/material-local-store.js'
import { createMaterialsService } from '../dist-electron/materials-service.js'
import { createRuntimePathState } from '../dist-electron/runtime-paths.js'
import { createTaskService } from '../dist-electron/task-service.js'
import {
  createWorkspaceService,
  readEnvFile,
  resolveWorkspacePath,
} from '../dist-electron/workspace-service.js'

const USER_DATA_ROOT = path.resolve(String(process.env.VIDEOAUTO_TEST_USER_DATA_ROOT || ''))
if (!USER_DATA_ROOT || USER_DATA_ROOT === path.parse(USER_DATA_ROOT).root) {
  throw new Error('必须通过 VIDEOAUTO_TEST_USER_DATA_ROOT 指定桌面端实际用户数据目录')
}

const CONFIG_ROOT = path.join(USER_DATA_ROOT, 'config')
const ENV_PATH = path.join(CONFIG_ROOT, 'app.env')
const AUTH_PATH = path.join(CONFIG_ROOT, 'auth.json')
const DEVICE_PATH = path.join(CONFIG_ROOT, 'device.json')
const savedEnv = readEnvFile(ENV_PATH)
const DATA_ROOT = resolveWorkspacePath(
  savedEnv.VIDEOAUTO_WORKSPACE_DIR || savedEnv.VIDEOAUTO_DATA_ROOT,
  USER_DATA_ROOT,
)
const RUNS_DIR = path.join(DATA_ROOT, 'video', 'runs')
const MATERIALS_DIR = path.join(DATA_ROOT, 'video', 'materials')
const MANIFESTS_DIR = path.join(DATA_ROOT, 'video', 'material-manifests')
const DATABASE_PATH = path.join(DATA_ROOT, 'video', 'material-library.sqlite')
const TEST_ARTIFACTS_DIR = path.join(DATA_ROOT, 'video', 'test-artifacts')
const resumeArtifactValue = String(process.env.VIDEOAUTO_TEST_RESUME_ARTIFACT || '').trim()
const resumeArtifactRoot = resumeArtifactValue ? path.resolve(resumeArtifactValue) : ''
if (resumeArtifactRoot) {
  const relativeResumePath = path.relative(TEST_ARTIFACTS_DIR, resumeArtifactRoot)
  if (relativeResumePath.startsWith('..') || path.isAbsolute(relativeResumePath)) {
    throw new Error('VIDEOAUTO_TEST_RESUME_ARTIFACT 必须位于当前工作区的 test-artifacts 目录内')
  }
}
const runtimeCurrentPath = path.join(DATA_ROOT, 'runtime', 'current.json')
const runtimeCurrent = JSON.parse(fs.readFileSync(runtimeCurrentPath, 'utf8'))
const runtimeRoot = path.resolve(String(runtimeCurrent.path || ''))
const runtimePaths = createRuntimePathState({
  initialRoot: runtimeRoot,
  engineExeName: 'VideoAutoCutEngine.exe',
})

if (!fs.existsSync(runtimePaths.exePath)) {
  throw new Error(`没有找到视频生成引擎：${runtimePaths.exePath}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const artifactRoot = path.join(TEST_ARTIFACTS_DIR, `material-reuse-${stamp}`)
fs.mkdirSync(artifactRoot, { recursive: true })

const workspace = createWorkspaceService({
  appName: 'VideoAutoCut Studio',
  userDataRoot: USER_DATA_ROOT,
  configRoot: CONFIG_ROOT,
  dataRoot: DATA_ROOT,
  legacyDataRoot: path.join(USER_DATA_ROOT, 'workspace'),
  envPath: ENV_PATH,
  runsDir: RUNS_DIR,
  defaultOutputDir: path.join(DATA_ROOT, 'video', 'output'),
  materialsDir: MATERIALS_DIR,
  voiceTemplatesDir: path.join(DATA_ROOT, 'voice_templates'),
  runtimeManifestDefaultUrl: '',
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
})
workspace.ensureDataLayout()

const account = createAccountService({
  authStatePath: AUTH_PATH,
  agentBaseUrl: 'https://agent.evstai.com',
  sub2ApiBaseUrl: 'https://api.evstai.com',
  registerUrl: 'https://agent.evstai.com',
  defaultRechargeUrl: 'https://api.evstai.com/api/v1/payment/orders',
  readEnv: workspace.readEnv,
  setRemoteEnv: workspace.setRemoteEnv,
  clearRemoteEnv: workspace.clearRemoteEnv,
})
account.syncRemoteConfigFromState()
const refreshedAuth = await account.authRefresh()
if (!refreshedAuth.ok) {
  throw new Error(`账号刷新失败：${refreshedAuth.message || '无法取得运行期 Qwen 网关凭据'}`)
}

const store = createMaterialLocalStore({
  dataRoot: DATA_ROOT,
  materialsDir: MATERIALS_DIR,
  runsDir: RUNS_DIR,
  databasePath: DATABASE_PATH,
  manifestsDir: MANIFESTS_DIR,
})
const analysisExporter = createMaterialAnalysisExporter({
  dataRoot: DATA_ROOT,
  getSentrySearchPaths: () => ({
    exe: runtimePaths.sentrySearchExe,
    python: runtimePaths.sentrySearchPython,
    entry: runtimePaths.sentrySearchEntry,
  }),
  createVideoAutoEnv: workspace.createVideoAutoEnv,
})

let activeTask = null
let blockPexelsForTask = false
const cloudEvents = []
const send = (_channel, payload) => {
  if (!payload || typeof payload !== 'object') return
  const event = payload
  if (event.type && String(event.type).startsWith('cloud-')) {
    cloudEvents.push({
      type: String(event.type),
      status: String(event.status || ''),
      materialId: String(event.materialId || ''),
      at: new Date().toISOString(),
    })
  }
  if (!activeTask) return
  if (typeof event.text === 'string') activeTask.logs.push(redact(event.text))
  if (event.runPath) activeTask.runPath = path.resolve(String(event.runPath))
  const stage = String(event.workflowStage || event.workflowProgress?.stage || '')
  if (stage && stage !== activeTask.lastStage) {
    activeTask.lastStage = stage
    console.log(`[${activeTask.label}] 阶段：${stage}`)
  }
  if (event.type === 'close') {
    activeTask.exitCode = Number(event.code)
    activeTask.resolve()
  }
}

const materialCloud = createMaterialCloudService({
  deviceId: getOrCreateDeviceId(DEVICE_PATH),
  readAuthState: account.readAuthState,
  readEnv: workspace.readEnv,
  send,
  store,
  exportAnalysisResult: analysisExporter.exportForFile,
  importAnalysisResult: analysisExporter.importForFile,
})

const materials = createMaterialsService({
  dataRoot: DATA_ROOT,
  materialsDir: MATERIALS_DIR,
  runsDir: RUNS_DIR,
  generatedRecordsPath: path.join(DATA_ROOT, 'tools', 'material_gen', 'records', 'generated_materials.json'),
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
  getPythonPath: () => runtimePaths.pythonPath,
  getSentrySearchPaths: () => ({
    exe: runtimePaths.sentrySearchExe,
    python: runtimePaths.sentrySearchPython,
    entry: runtimePaths.sentrySearchEntry,
  }),
  listRuns: workspace.listRuns,
  createVideoAutoEnv: workspace.createVideoAutoEnv,
  assertInsideWorkspace: workspace.assertInsideWorkspace,
  resolveExistingOrParent: workspace.resolveExistingOrParent,
  isInsideDir: workspace.isInsideDir,
  safeRemoveFile: workspace.safeRemoveFile,
  safeRemoveDirectory: workspace.safeRemoveDirectory,
  samePath: workspace.samePath,
  isRuntimeUsable: () => fs.existsSync(runtimePaths.exePath),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  send,
  identityStore: store,
  cloudSemanticSearch: (query, options) => materialCloud.semanticSearch({ query, ...options }),
  ensureCloudMaterialAvailable: (materialId) => materialCloud.downloadMaterial({ materialId }),
  onDownloadedMaterials: (files) => {
    materialCloud.queueUploads({ paths: files.map((file) => file.path) })
  },
  hasExistingAnalysis: analysisExporter.hasForFile,
})

let postprocessTail = Promise.resolve()
let generationStatusTail = Promise.resolve()
const taskService = createTaskService({
  getVideoAutoRoot: () => runtimePaths.videoAutoRoot,
  getExePath: () => runtimePaths.exePath,
  createVideoAutoEnv: (extra = {}) => {
    const env = workspace.createVideoAutoEnv(extra)
    if (blockPexelsForTask) env.PEXELS_API_KEY = '__VIDEOAUTO_REUSE_TEST_BLOCKED__'
    return env
  },
  isRuntimeUsable: () => fs.existsSync(runtimePaths.exePath),
  send,
  onDownloadedMaterials: (runPath, options) => {
    const work = postprocessTail.then(() => materials.processDownloadedMaterials(runPath, options))
    postprocessTail = work.catch(() => undefined)
    return work
  },
  onGenerationStatus: (...args) => {
    const work = generationStatusTail.then(() => materialCloud.queueGenerationStatus(...args))
    generationStatusTail = work.catch(() => undefined)
    return work
  },
})

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:token|key|signature|credential)=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|secret|token)\s*[:=]\s*)[^\s"']+/gi, '$1[已隐藏]')
}

function sha256(filePath) {
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

function writeJson(fileName, value) {
  const filePath = path.join(artifactRoot, fileName)
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return filePath
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPostprocessing() {
  let previous = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = postprocessTail
    await current
    await sleep(200)
    if (current === postprocessTail && current === previous) return
    previous = current
  }
  await postprocessTail
}

async function executeTask(label, options, timeoutMs = 30 * 60_000) {
  if (activeTask) throw new Error('测试脚本检测到并发任务')
  let resolveClose
  const closed = new Promise((resolve) => { resolveClose = resolve })
  const capture = {
    label,
    logs: [],
    runPath: '',
    lastStage: '',
    exitCode: null,
    resolve: resolveClose,
  }
  activeTask = capture
  console.log(`[${label}] 启动任务`)
  const started = await taskService.start(options)
  if (!started.ok) {
    activeTask = null
    throw new Error(`${label} 启动失败：${started.message || '未知错误'}`)
  }
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 等待超时`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    activeTask = null
  }
  await sleep(300)
  if (capture.exitCode !== 0) {
    writeJson(`${label}-failure.json`, capture)
    throw new Error(`${label} 失败，退出代码 ${capture.exitCode}`)
  }
  if (!capture.runPath || !fs.existsSync(capture.runPath)) {
    throw new Error(`${label} 没有返回有效运行目录`)
  }
  fs.writeFileSync(path.join(artifactRoot, `${label}.log`), capture.logs.join(''), 'utf8')
  console.log(`[${label}] 完成：${capture.runPath}`)
  return capture
}

function originalVideoFiles(files) {
  return files.filter((file) => (
    !file.path.split(/[\\/]+/).some((part) => part.toLocaleLowerCase() === '_indexed_h264')
    && ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'].includes(path.extname(file.path).toLocaleLowerCase())
  ))
}

function hasPexelsProvenance(runPath, logs) {
  if (/pexels:\d+|api\.pexels\.com|source["']?\s*[:=]\s*["']?pexels/i.test(logs.join(''))) return true
  const pending = [runPath]
  let inspected = 0
  while (pending.length && inspected < 400) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!['_indexed_h264'].includes(entry.name.toLocaleLowerCase())) pending.push(item)
        continue
      }
      inspected += 1
      if (/pexels/i.test(entry.name)) return true
      if (!/\.(json|jsonl|txt|log)$/i.test(entry.name)) continue
      if (fs.statSync(item).size > 5 * 1024 * 1024) continue
      const text = fs.readFileSync(item, 'utf8')
      if (/pexels:\d+|api\.pexels\.com|["']source["']\s*:\s*["']pexels["']/i.test(text)) return true
    }
  }
  return false
}

async function waitForCloudReady(materialId, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastState = ''
  while (Date.now() < deadline) {
    await materialCloud.processQueue()
    await materialCloud.syncNow()
    const material = store.getMaterialCloudFileById(materialId)
    const status = materialCloud.status()
    const state = [
      material?.cloudStatus,
      material?.analysisStatus,
      material?.cloudAnalysisStatus,
      status.pendingOperations,
      status.failedOperations,
    ].join('/')
    if (state !== lastState) {
      console.log(`[云同步] ${state}`)
      lastState = state
    }
    if (
      material?.cloudStatus === 'ready'
      && material.analysisStatus === 'ready'
      && material.cloudAnalysisStatus === 'ready'
    ) return { material, status }
    if (material?.cloudStatus === 'failed') {
      throw new Error(`素材云上传失败：${material.cloudError || status.lastError || '未知错误'}`)
    }
    if (material?.analysisStatus === 'failed') {
      throw new Error(`素材本地分析失败：${material.analysisError || '未知错误'}`)
    }
    await sleep(1500)
  }
  const material = store.getMaterialCloudFileById(materialId)
  throw new Error(`等待云端就绪超时：${JSON.stringify({
    cloudStatus: material?.cloudStatus,
    analysisStatus: material?.analysisStatus,
    cloudAnalysisStatus: material?.cloudAnalysisStatus,
    cloud: materialCloud.status(),
  })}`)
}

async function resumeSecondPass(sourceArtifactRoot) {
  const priorResultPath = path.join(sourceArtifactRoot, 'result.json')
  const firstShotsPath = path.join(sourceArtifactRoot, 'first-shots.json')
  if (!fs.existsSync(priorResultPath) || !fs.existsSync(firstShotsPath)) {
    throw new Error('恢复测试缺少 result.json 或 first-shots.json')
  }

  const priorResult = JSON.parse(fs.readFileSync(priorResultPath, 'utf8'))
  const firstPlan = JSON.parse(fs.readFileSync(firstShotsPath, 'utf8'))
  const firstFiles = Array.isArray(priorResult.first_run?.downloaded_files)
    ? priorResult.first_run.downloaded_files
    : []
  if (priorResult.first_run?.exit_code !== 0 || !firstFiles.length || !Array.isArray(firstPlan.shots)) {
    throw new Error('恢复测试的第一次运行记录不完整')
  }

  const liveRecords = []
  for (const file of firstFiles) {
    const filePath = path.resolve(String(file.path || ''))
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) {
      throw new Error(`第一次下载的本地素材已丢失：${filePath}`)
    }
    const currentHash = sha256(filePath)
    if (currentHash !== file.source_sha256) {
      throw new Error(`第一次下载的本地素材哈希已变化：${filePath}`)
    }
    const cloudReady = await waitForCloudReady(String(file.material_id || ''))
    liveRecords.push({ file, filePath, currentHash, identity: cloudReady.material })
  }

  console.log('[第二次恢复测试] 重新使用完全相同的分镜内容检索素材库')
  const secondResolution = await materials.autoResolveShotMaterials({
    shots: firstPlan.shots,
    fallbackSource: 'pexels',
  })
  const reuseDecision = secondResolution.decisions?.[0]
  const reusedRecord = liveRecords.find(({ identity }) => identity.materialId === reuseDecision?.materialId)
  if (secondResolution.matched !== 1 || !reusedRecord) {
    throw new Error(`第二次没有命中第一次下载的素材：${JSON.stringify(reuseDecision || {})}`)
  }

  const taskId = `real-material-reuse-resume-${randomUUID()}`
  const secondPlan = {
    schema_version: 2,
    task_revision: 1,
    topic: priorResult.content?.topic || firstPlan.topic || '',
    shots: secondResolution.shots,
  }
  store.saveTaskDraft({
    taskId,
    schemaVersion: 2,
    expectedRevision: 0,
    snapshot: secondPlan,
  })
  const secondShotsPath = writeJson('second-shots.json', secondPlan)
  const prepared = await materialCloud.prepareGenerationManifest({
    taskId,
    taskRevision: 1,
    shots: secondResolution.shots,
  })
  const manifestMaterial = prepared.manifest.shots?.[0]?.materials?.[0]
  if (!manifestMaterial) throw new Error('第二次生成清单没有冻结已复用素材')

  blockPexelsForTask = true
  let secondTask
  try {
    secondTask = await executeTask('second-run-retry', {
      shotsJson: secondShotsPath,
      source: 'pexels',
      downloadNewMaterials: false,
      materialManifestPath: prepared.manifestPath,
    })
  } finally {
    blockPexelsForTask = false
  }

  const secondPexelsEvidence = hasPexelsProvenance(secondTask.runPath, secondTask.logs)
  const { file: reusedFile, currentHash, identity } = reusedRecord
  result.resumed_from = sourceArtifactRoot
  result.content = priorResult.content
  result.preflight = priorResult.preflight
  result.first_run = {
    ...priorResult.first_run,
    reused_downloaded_file: reusedFile.path,
    reused_material_id: identity.materialId,
  }
  result.second_run = {
    exit_code: secondTask.exitCode,
    run_path: secondTask.runPath,
    reuse_decision: reuseDecision,
    download_material: secondResolution.shots?.[0]?.download_material,
    manifest_path: prepared.manifestPath,
    manifest_material_id: manifestMaterial.material_id,
    manifest_asset_id: manifestMaterial.asset_id,
    manifest_asset_version: manifestMaterial.asset_version,
    manifest_source_sha256: manifestMaterial.source_sha256,
    pexels_credential_intentionally_blocked: true,
    pexels_download_evidence_found: secondPexelsEvidence,
  }
  result.assertions = {
    first_task_succeeded: priorResult.first_run.exit_code === 0,
    first_downloaded_real_local_file: liveRecords.every(({ filePath }) => (
      fs.existsSync(filePath) && fs.statSync(filePath).size > 0
    )),
    first_downloaded_file_hash_unchanged: liveRecords.every(({ file, currentHash: hash }) => (
      hash === file.source_sha256
    )),
    first_has_pexels_provenance: priorResult.first_run.pexels_provenance_found === true,
    first_registered_in_material_library: liveRecords.every(({ identity: item }) => Boolean(item.materialId)),
    first_local_analysis_ready: liveRecords.every(({ identity: item }) => item.analysisStatus === 'ready'),
    first_cos_upload_verified: liveRecords.every(({ identity: item }) => (
      item.cloudStatus === 'ready' && item.cloudRevision >= 1
    )),
    first_cloud_analysis_ready: liveRecords.every(({ identity: item }) => item.cloudAnalysisStatus === 'ready'),
    second_reused_first_material: reuseDecision?.materialId === identity.materialId,
    second_disabled_download_flag: secondResolution.shots?.[0]?.download_material === false,
    second_manifest_identity_matches: (
      manifestMaterial.material_id === identity.materialId
      && manifestMaterial.asset_id === identity.assetId
      && manifestMaterial.asset_version === identity.assetVersion
      && manifestMaterial.source_sha256 === currentHash
    ),
    second_succeeded_with_invalid_pexels_credential: secondTask.exitCode === 0,
  }
  result.passed = Object.values(result.assertions).every(Boolean)
  result.finished_at = new Date().toISOString()
  result.cloud_events = cloudEvents
  writeJson('result.json', result)
  console.log(`[结果] ${result.passed ? '通过' : '未通过'}`)
  console.log(`[结果文件] ${path.join(artifactRoot, 'result.json')}`)
  if (!result.passed) process.exitCode = 2
}

const candidates = [
  {
    topic: '陶艺工作室手工制作',
    title: '陶艺师塑造湿黏土特写',
    download_query: 'potter hands shaping wet clay on pottery wheel close up',
    visual_query: '陶艺师双手在旋转的陶轮上塑造湿黏土，工作室自然光，稳定近景',
    voice_text: '旋转之间，泥土逐渐拥有了形状。',
  },
  {
    topic: '蜂场采蜜观察',
    title: '养蜂人查看蜂巢特写',
    download_query: 'beekeeper inspecting honeycomb frame close up bees',
    visual_query: '穿防护服的养蜂人举起蜂巢板观察蜜蜂，户外蜂场，细节近景',
    voice_text: '每一格蜂巢，都记录着自然的协作。',
  },
  {
    topic: '海底生态观察',
    title: '海龟游过珊瑚礁',
    download_query: 'sea turtle swimming over coral reef underwater',
    visual_query: '一只海龟缓慢游过阳光照亮的珊瑚礁，清澈海水，平稳跟拍',
    voice_text: '海面之下，生命仍在安静地延续。',
  },
  {
    topic: '玻璃工艺制作',
    title: '玻璃工匠塑造熔融玻璃',
    download_query: 'glassblower shaping molten glass workshop close up',
    visual_query: '玻璃工匠在高温工作室旋转吹管塑造橙红色熔融玻璃，手部操作近景',
    voice_text: '火焰与呼吸，让玻璃获得流动的形状。',
  },
  {
    topic: '寿司料理制作',
    title: '寿司师傅切三文鱼特写',
    download_query: 'sushi chef slicing salmon close up restaurant kitchen',
    visual_query: '寿司师傅在整洁料理台上切三文鱼，刀具和食材细节近景',
    voice_text: '精准的一刀，决定了食材最终的口感。',
  },
]

const result = {
  started_at: new Date().toISOString(),
  artifact_root: artifactRoot,
  services: {},
  content: null,
  preflight: null,
  first_run: null,
  second_run: null,
  assertions: {},
  passed: false,
}

try {
  const initialCloud = await materialCloud.syncNow()
  result.services = {
    runtime_version: String(runtimeCurrent.version || ''),
    cloud_configured: initialCloud.configured,
    cloud_authenticated: initialCloud.authenticated,
    cloud_online: initialCloud.online,
  }
  if (!initialCloud.configured || !initialCloud.authenticated || !initialCloud.online) {
    throw new Error(`素材云服务不可用：${initialCloud.lastError || '配置、登录或网络状态异常'}`)
  }

  if (resumeArtifactRoot) {
    await resumeSecondPass(resumeArtifactRoot)
  } else {
  let selected = null
  const preflightAttempts = []
  for (const [index, content] of candidates.entries()) {
    const shot = {
      shot_id: `shot_real_reuse_${index + 1}`,
      shot: 1,
      title: content.title,
      duration: 4,
      time_range: '00:00-00:04',
      voice_text: content.voice_text,
      download_query: content.download_query,
      visual_query: content.visual_query,
      clip_requirements: '横屏稳定近景，避免字幕和水印',
      download_material: true,
      material_bindings: [],
    }
    console.log(`[预检] 搜索：${content.title}`)
    const resolution = await materials.autoResolveShotMaterials({
      shots: [shot],
      fallbackSource: 'pexels',
    })
    const decision = resolution.decisions?.[0]
    let diagnostic = null
    if (decision?.reason === 'search_unavailable') {
      const search = await materials.semanticSearch(decision.query, {
        results: 5,
        threshold: -1,
        noTrim: true,
      })
      diagnostic = {
        ok: search.ok,
        code: search.code,
        message: redact(search.message || ''),
        raw_tail: redact(String(search.raw || '').slice(-1200)),
      }
    }
    preflightAttempts.push({
      title: content.title,
      matched: resolution.matched,
      fallback: resolution.fallback,
      decision,
      diagnostic,
    })
    console.log(`[预检] 判定：${JSON.stringify({
      matched: resolution.matched,
      fallback: resolution.fallback,
      status: decision?.status,
      reason: decision?.reason,
      score: decision?.score,
      materialId: decision?.materialId,
      diagnostic,
    })}`)
    if (resolution.fallback === 1 && decision?.reason === 'below_threshold') {
      selected = { content, shot, resolution }
      break
    }
  }
  result.preflight_attempts = preflightAttempts
  if (!selected) throw new Error('没有找到可用于首次下载的未命中测试内容，或素材语义检索不可用')

  result.content = selected.content
  result.preflight = {
    matched: selected.resolution.matched,
    fallback: selected.resolution.fallback,
    decision: selected.resolution.decisions?.[0],
  }
  const firstPlan = {
    schema_version: 2,
    task_revision: 0,
    topic: selected.content.topic,
    shots: [selected.shot],
  }
  const firstShotsPath = writeJson('first-shots.json', firstPlan)

  blockPexelsForTask = false
  const firstTask = await executeTask('first-run', {
    shotsJson: firstShotsPath,
    source: 'pexels',
    downloadNewMaterials: true,
  })
  await waitForPostprocessing()
  const processed = await materials.processDownloadedMaterials(firstTask.runPath, {
    markIndexedReady: true,
    verifyIndexedAnalysis: true,
    analyzeMissing: true,
  })
  const downloadedFiles = originalVideoFiles(processed.files || [])
  if (!downloadedFiles.length) throw new Error('第一次任务没有产生可用的本地下载素材')
  const downloadedRecords = []
  for (const downloadedFile of downloadedFiles) {
    if (!fs.existsSync(downloadedFile.path)) continue
    const localIdentity = store.getMaterialCloudFileByPath(downloadedFile.path)
    if (!localIdentity) throw new Error(`第一次下载素材没有写入本地素材库：${downloadedFile.path}`)
    const cloudReady = await waitForCloudReady(localIdentity.materialId)
    downloadedRecords.push({
      file: downloadedFile,
      sourceSha256: sha256(downloadedFile.path),
      identity: cloudReady.material,
    })
  }
  if (!downloadedRecords.length) throw new Error('第一次任务的下载素材均不可用')
  const pexelsProvenance = hasPexelsProvenance(firstTask.runPath, firstTask.logs)

  result.first_run = {
    exit_code: firstTask.exitCode,
    run_path: firstTask.runPath,
    downloaded_files: downloadedRecords.map(({ file, sourceSha256, identity }) => ({
      path: file.path,
      file_size: fs.statSync(file.path).size,
      source_sha256: sourceSha256,
      material_id: identity.materialId,
      asset_id: identity.assetId,
      asset_version: identity.assetVersion,
      origin: identity.origin,
      added_from: identity.addedFrom,
      local_status: identity.localStatus,
      analysis_status: identity.analysisStatus,
      cloud_status: identity.cloudStatus,
      cloud_analysis_status: identity.cloudAnalysisStatus,
      cloud_revision: identity.cloudRevision,
    })),
    pexels_provenance_found: pexelsProvenance,
  }

  console.log('[第二次] 使用完全相同的分镜内容执行自动素材检索')
  const secondResolution = await materials.autoResolveShotMaterials({
    shots: [selected.shot],
    fallbackSource: 'pexels',
  })
  const reuseDecision = secondResolution.decisions?.[0]
  const reusedRecord = downloadedRecords.find(({ identity }) => identity.materialId === reuseDecision?.materialId)
  if (secondResolution.matched !== 1 || !reusedRecord) {
    throw new Error(`第二次没有命中第一次下载的素材：${JSON.stringify(reuseDecision || {})}`)
  }
  const { file: downloaded, sourceSha256: firstHash, identity } = reusedRecord
  result.first_run.reused_downloaded_file = downloaded.path
  result.first_run.reused_material_id = identity.materialId
  const taskId = `real-material-reuse-${randomUUID()}`
  const secondPlan = {
    schema_version: 2,
    task_revision: 1,
    topic: selected.content.topic,
    shots: secondResolution.shots,
  }
  store.saveTaskDraft({
    taskId,
    schemaVersion: 2,
    expectedRevision: 0,
    snapshot: secondPlan,
  })
  const secondShotsPath = writeJson('second-shots.json', secondPlan)
  const prepared = await materialCloud.prepareGenerationManifest({
    taskId,
    taskRevision: 1,
    shots: secondResolution.shots,
  })
  const manifest = prepared.manifest
  const manifestMaterial = manifest.shots?.[0]?.materials?.[0]
  if (!manifestMaterial) throw new Error('第二次生成清单没有冻结已复用素材')

  blockPexelsForTask = true
  const secondTask = await executeTask('second-run', {
    shotsJson: secondShotsPath,
    source: 'pexels',
    downloadNewMaterials: false,
    materialManifestPath: prepared.manifestPath,
  })
  blockPexelsForTask = false
  const secondPexelsEvidence = hasPexelsProvenance(secondTask.runPath, secondTask.logs)

  result.second_run = {
    exit_code: secondTask.exitCode,
    run_path: secondTask.runPath,
    reuse_decision: reuseDecision,
    download_material: secondResolution.shots?.[0]?.download_material,
    manifest_path: prepared.manifestPath,
    manifest_material_id: manifestMaterial.material_id,
    manifest_asset_id: manifestMaterial.asset_id,
    manifest_asset_version: manifestMaterial.asset_version,
    manifest_source_sha256: manifestMaterial.source_sha256,
    pexels_credential_intentionally_blocked: true,
    pexels_download_evidence_found: secondPexelsEvidence,
  }

  result.assertions = {
    first_task_succeeded: firstTask.exitCode === 0,
    first_downloaded_real_local_file: downloadedRecords.every(({ file }) => (
      fs.existsSync(file.path) && fs.statSync(file.path).size > 0
    )),
    first_has_pexels_provenance: pexelsProvenance,
    first_registered_in_material_library: downloadedRecords.every(({ identity: item }) => Boolean(item.materialId)),
    first_local_analysis_ready: downloadedRecords.every(({ identity: item }) => item.analysisStatus === 'ready'),
    first_cos_upload_verified: downloadedRecords.every(({ identity: item }) => (
      item.cloudStatus === 'ready' && item.cloudRevision >= 1
    )),
    first_cloud_analysis_ready: downloadedRecords.every(({ identity: item }) => item.cloudAnalysisStatus === 'ready'),
    second_reused_first_material: reuseDecision?.materialId === identity.materialId,
    second_disabled_download_flag: secondResolution.shots?.[0]?.download_material === false,
    second_manifest_identity_matches: (
      manifestMaterial.material_id === identity.materialId
      && manifestMaterial.asset_id === identity.assetId
      && manifestMaterial.asset_version === identity.assetVersion
      && manifestMaterial.source_sha256 === firstHash
    ),
    second_succeeded_with_invalid_pexels_credential: secondTask.exitCode === 0,
  }
  result.passed = Object.values(result.assertions).every(Boolean)
  result.finished_at = new Date().toISOString()
  result.cloud_events = cloudEvents
  writeJson('result.json', result)
  console.log(`[结果] ${result.passed ? '通过' : '未通过'}`)
  console.log(`[结果文件] ${path.join(artifactRoot, 'result.json')}`)
  if (!result.passed) process.exitCode = 2
  }
} catch (error) {
  blockPexelsForTask = false
  result.finished_at = new Date().toISOString()
  result.error = redact(error instanceof Error ? error.stack || error.message : String(error))
  result.cloud_events = cloudEvents
  writeJson('result.json', result)
  console.error(`[结果] 失败：${redact(error instanceof Error ? error.message : String(error))}`)
  console.error(`[结果文件] ${path.join(artifactRoot, 'result.json')}`)
  process.exitCode = 1
} finally {
  await postprocessTail.catch(() => undefined)
  await generationStatusTail.catch(() => undefined)
  await materialCloud.processQueue().catch(() => undefined)
  await sleep(200)
  await generationStatusTail.catch(() => undefined)
  await materialCloud.processQueue().catch(() => undefined)
  materialCloud.stop()
  store.close()
}
