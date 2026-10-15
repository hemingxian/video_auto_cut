import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { REMOTE_MANAGED_ENV_KEYS } from '../electron/managed-env-keys.ts'
import { withoutGatewayCredentials } from '../dist-electron/managed-config.js'
import { isRunDeletionBlocked, writeTaskHistory } from '../dist-electron/task-history.js'
import {
  createWorkspaceService,
  formatEnvAssignment,
  readEnvFile,
  resolveRuntimeManagedEnv,
} from '../dist-electron/workspace-service.js'

function workspaceServiceFor(directory, envPath) {
  const dataRoot = path.join(directory, 'data')
  return createWorkspaceService({
    appName: 'VideoAutoCut Test',
    userDataRoot: directory,
    configRoot: path.dirname(envPath),
    dataRoot,
    legacyDataRoot: path.join(directory, 'legacy'),
    envPath,
    runsDir: path.join(dataRoot, 'video', 'runs'),
    defaultOutputDir: path.join(dataRoot, 'video', 'output'),
    materialsDir: path.join(dataRoot, 'video', 'materials'),
    voiceTemplatesDir: path.join(dataRoot, 'voice_templates'),
    runtimeManifestDefaultUrl: '',
    getVideoAutoRoot: () => path.join(directory, 'runtime'),
  })
}

function historyWorkspaceFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-history-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runsRoot = path.join(directory, 'data', 'video', 'runs')
  function run(id, manifest, project = '同名脚本') {
    const dir = path.join(runsRoot, '20260915', project, '.videoautocut', 'runs', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'run.log'), '')
    fs.writeFileSync(path.join(dir, 'shots.json'), '{"shots":[]}')
    if (manifest) fs.writeFileSync(path.join(dir, 'material_manifest.json'), JSON.stringify(manifest))
    return dir
  }
  return { run, service: workspaceServiceFor(directory, path.join(directory, 'config', 'app.env')) }
}

test('history keeps physical runs available and links Pexels-only generation by its explicit manifest task id', (t) => {
  const { run, service } = historyWorkspaceFixture(t)
  run('preview')
  run('generated', { schema_version: 1, run_id: 'generated', task_id: 'preview', shots: [{ shot_id: 'one', materials: [] }] })
  run('same-name-independent')
  run('same-script-repeated')
  const records = service.listRuns()
  assert.equal(records.length, 4)
  assert.equal(records.find((item) => item.id === 'generated').sourceRunId, 'preview')
  assert.equal(records.filter((item) => item.sourceRunId).length, 1)
  assert.ok(records.every((item) => fs.existsSync(item.shotsPath)))
})

test('history exposes the saved task resolution for restoration without changing old records', (t) => {
  const { run, service } = historyWorkspaceFixture(t)
  const current = run('4k-portrait')
  const old = run('legacy-landscape')
  fs.writeFileSync(path.join(current, 'output-format.json'), JSON.stringify({ aspect_ratio: '9:16', resolution: '4k', width: 2160, height: 3840 }))
  fs.writeFileSync(path.join(old, 'output-format.json'), JSON.stringify({ aspect_ratio: '16:9', width: 1920, height: 1080 }))
  const records = service.listRuns()
  assert.deepEqual(records.find((record) => record.id === '4k-portrait').outputFormat,
    { aspectRatio: '9:16', outputResolution: '4k', width: 2160, height: 3840 })
  assert.equal(records.find((record) => record.id === 'legacy-landscape').outputFormat.outputResolution, '1080p')
})

test('history reports incremental journal presence without reading its contents', (t) => {
  const { run, service } = historyWorkspaceFixture(t)
  const interrupted = run('interrupted')
  run('plan-only')
  const incrementalPath = path.join(interrupted, 'incremental.json')
  fs.writeFileSync(incrementalPath, '{ damaged but present')

  const records = service.listRuns()
  assert.equal(records.find((record) => record.id === 'interrupted').incrementalPath, incrementalPath)
  assert.equal(records.find((record) => record.id === 'plan-only').incrementalPath, undefined)
})

test('history without a manifest uses the actual source storyboard path and preserves it across resume', (t) => {
  const { run, service } = historyWorkspaceFixture(t)
  const previewPath = run('preview')
  const generatedPath = run('generated')
  const previewShots = path.join(previewPath, 'shots.json')
  writeTaskHistory(generatedPath, previewShots)
  const beforeResume = fs.readFileSync(path.join(generatedPath, 'run_history.json'), 'utf8')
  writeTaskHistory(generatedPath, path.join(generatedPath, 'shots.json'))
  assert.equal(fs.readFileSync(path.join(generatedPath, 'run_history.json'), 'utf8'), beforeResume)
  assert.equal(service.listRuns().find((item) => item.id === 'generated').sourceRunId, 'preview')
  const independentPath = run('independent')
  writeTaskHistory(independentPath)
  assert.equal(fs.existsSync(path.join(independentPath, 'run_history.json')), false)
})

test('history rejects mismatched manifests, unknown source paths, conflicting origins and ambiguous ids', (t) => {
  const { run, service } = historyWorkspaceFixture(t)
  const previewPath = run('preview')
  const otherPath = run('other')
  run('wrong-manifest', { schema_version: 1, run_id: 'something-else', task_id: 'preview' })
  run('dangling', { schema_version: 1, run_id: 'dangling', task_id: 'missing' })
  const conflicting = run('conflicting', { schema_version: 1, run_id: 'conflicting', task_id: 'preview' })
  writeTaskHistory(conflicting, path.join(otherPath, 'shots.json'))
  const invalidPath = run('outside-path')
  fs.writeFileSync(path.join(invalidPath, 'run_history.json'), JSON.stringify({
    schema_version: 1, run_id: 'outside-path', source_shots_path: path.join(previewPath, '..', 'outside-shots.json'),
  }))
  run('duplicate', undefined, '项目一')
  run('duplicate', undefined, '项目二')
  run('ambiguous', { schema_version: 1, run_id: 'ambiguous', task_id: 'duplicate' })
  assert.equal(service.listRuns().filter((item) => item.sourceRunId).length, 0)
})

test('history deletion rechecks the exact active run and source storyboard without locking other tasks', (t) => {
  const { run, service } = historyWorkspaceFixture(t)
  const previewPath = run('preview')
  const generatedPath = run('generated')
  run('independent')
  const records = service.listRuns()
  const active = { running: true, runId: 'generated', runPath: generatedPath, shotsJson: path.join(previewPath, 'shots.json') }
  assert.equal(isRunDeletionBlocked(records.find((item) => item.id === 'generated'), active), true)
  assert.equal(isRunDeletionBlocked(records.find((item) => item.id === 'preview'), active), true)
  assert.equal(isRunDeletionBlocked(records.find((item) => item.id === 'independent'), active), false)
  assert.equal(isRunDeletionBlocked(records.find((item) => item.id === 'generated'), { running: true, runId: 'generated' }), true)
  assert.equal(isRunDeletionBlocked(records.find((item) => item.id === 'preview'), { ...active, running: false }), false)
  assert.equal(isRunDeletionBlocked(records.find((item) => item.id === 'preview'), { ...active, runId: 'preview', shotsJson: undefined }), false)
})

test('checkpoint reads support Windows namespace paths and retain workspace boundaries', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-checkpoint-'))
  try {
    const file = path.join(directory, 'data', '中文任务', 'checkpoint.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"version":1}')
    const service = workspaceServiceFor(directory, path.join(directory, 'config', 'app.env'))
    assert.equal(service.readTextFile(path.toNamespacedPath(file)), '{"version":1}')
    const outside = path.join(directory, 'outside.json')
    fs.writeFileSync(outside, '{}')
    assert.throws(() => service.readTextFile(path.toNamespacedPath(outside)), /不在工作区/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('env values containing spaces are quoted and decoded', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-env-'))
  const file = path.join(directory, 'app.env')

  try {
    const line = formatEnvAssignment('SUBTITLE_FONT', 'Microsoft YaHei')
    assert.equal(line, 'SUBTITLE_FONT="Microsoft YaHei"')
    fs.writeFileSync(file, `${line}\n`, 'utf8')
    assert.equal(readEnvFile(file).SUBTITLE_FONT, 'Microsoft YaHei')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('engine environment keeps the selected custom progress template', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-progress-env-'))
  const configRoot = path.join(directory, 'config')
  const envPath = path.join(configRoot, 'app.env')

  try {
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(envPath, 'PROGRESS_TEMPLATE=user-news\n', 'utf8')
    const env = workspaceServiceFor(directory, envPath).createVideoAutoEnv()
    assert.equal(env.PROGRESS_TEMPLATE, 'user-news')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workspace history discovers runs stored outside dated task material folders', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-dated-runs-'))
  const envPath = path.join(directory, 'config', 'app.env')
  const taskDirectory = path.join(
    directory,
    'data',
    'video',
    'runs',
    '20260902',
    '纸飞机投放版',
  )
  const runDirectory = path.join(
    directory,
    'data',
    'video',
    'runs',
    '.videoautocut',
    '20260902',
    '纸飞机投放版',
    'run_test_12345',
  )

  try {
    fs.mkdirSync(runDirectory, { recursive: true })
    fs.writeFileSync(path.join(runDirectory, 'run.log'), '', 'utf8')
    fs.writeFileSync(path.join(runDirectory, 'shots.json'), '{}', 'utf8')
    fs.mkdirSync(path.join(runDirectory, 'clips', '01'), { recursive: true })
    fs.writeFileSync(path.join(runDirectory, 'clips', '01', 'clip.mp4'), 'clip', 'utf8')
    fs.mkdirSync(path.join(taskDirectory, '_indexed_h264'), { recursive: true })
    fs.writeFileSync(path.join(taskDirectory, 'candidate.mp4'), 'candidate', 'utf8')
    fs.writeFileSync(path.join(taskDirectory, '_indexed_h264', 'internal.mp4'), 'internal', 'utf8')
    const runs = workspaceServiceFor(directory, envPath).listRuns()

    assert.equal(runs.length, 1)
    assert.equal(runs[0].id, 'run_test_12345')
    assert.equal(runs[0].projectName, '纸飞机投放版')
    assert.equal(runs[0].path, fs.realpathSync(runDirectory))
    assert.deepEqual(
      runs[0].artifacts
        .filter(({ ext }) => ext === '.mp4')
        .map(({ name, relativePath }) => ({ name, relativePath }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      [
        { name: 'clip.mp4', relativePath: path.join('clips', '01', 'clip.mp4') },
        { name: 'candidate.mp4', relativePath: path.join('raw', 'candidate.mp4') },
      ],
    )
    assert.equal(runs[0].finalVideo, '')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workspace history discovers storyboard candidates and project-versioned final videos', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-project-library-runs-'))
  const envPath = path.join(directory, 'config', 'app.env')
  const projectDirectory = path.join(
    directory,
    'data',
    'video',
    'runs',
    '20260903',
    '上下料B端视频',
  )
  const runDirectory = path.join(
    projectDirectory,
    '.videoautocut',
    'runs',
    'run_test_67890',
  )
  const candidatePath = path.join(projectDirectory, '分镜视频', '01 · 痛点引入', 'candidate.mp4')
  const indexedPath = path.join(
    projectDirectory,
    '分镜视频',
    '01 · 痛点引入',
    '_indexed_h264',
    'internal.mp4',
  )
  const finalPath = path.join(
    projectDirectory,
    '上下料B端视频最终视频',
    '上下料B端视频_v001.mp4',
  )

  try {
    fs.mkdirSync(runDirectory, { recursive: true })
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true })
    fs.mkdirSync(path.dirname(indexedPath), { recursive: true })
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    fs.writeFileSync(path.join(runDirectory, 'run.log'), '', 'utf8')
    fs.writeFileSync(path.join(runDirectory, 'shots.json'), '{}', 'utf8')
    fs.writeFileSync(candidatePath, 'candidate', 'utf8')
    fs.writeFileSync(indexedPath, 'indexed', 'utf8')
    fs.writeFileSync(finalPath, 'final', 'utf8')
    fs.writeFileSync(path.join(runDirectory, 'final_video.json'), JSON.stringify({
      schema_version: 1,
      run_id: 'run_test_67890',
      path: path.toNamespacedPath(finalPath),
    }), 'utf8')

    const runs = workspaceServiceFor(directory, envPath).listRuns()

    assert.equal(runs.length, 1)
    assert.equal(runs[0].projectName, '上下料B端视频')
    assert.equal(runs[0].finalVideo, fs.realpathSync(finalPath))
    assert.deepEqual(
      runs[0].artifacts
        .filter(({ ext }) => ext === '.mp4')
        .map(({ name, relativePath }) => ({ name, relativePath })),
      [
        { name: '上下料B端视频_v001.mp4', relativePath: path.join('output', '上下料B端视频_v001.mp4') },
        { name: 'candidate.mp4', relativePath: path.join('分镜视频', '01 · 痛点引入', 'candidate.mp4') },
      ],
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('remote config allowlist covers the shared DashScope relay and native APIs', () => {
  const expected = [
    'DASHSCOPE_BASE_URL',
    'DASHSCOPE_HTTP_BASE_URL',
    'DASHSCOPE_UPLOADS_URL',
    'DASHSCOPE_TTS_URL',
    'DASHSCOPE_ASR_TRANSCRIPTION_URL',
    'DASHSCOPE_ASR_TASK_BASE_URL',
    'DASHSCOPE_VOICE_CUSTOMIZATION_URL',
  ]

  for (const key of expected) assert.ok(REMOTE_MANAGED_ENV_KEYS.includes(key), key)
})

test('gateway credentials only enter the engine from the signed-in account overlay', () => {
  const fileEnv = {
    DASHSCOPE_API_KEY: 'stale-file-key',
    DASHSCOPE_BASE_URL: 'https://dashscope.aliyuncs.com',
    PEXELS_API_KEY: 'pexels-key',
  }

  assert.deepEqual(resolveRuntimeManagedEnv(fileEnv, {}), {
    PEXELS_API_KEY: 'pexels-key',
  })
  assert.deepEqual(resolveRuntimeManagedEnv(fileEnv, {
    DASHSCOPE_API_KEY: 'account-key',
    DASHSCOPE_BASE_URL: 'https://api.evstai.com',
  }), {
    DASHSCOPE_API_KEY: 'account-key',
    DASHSCOPE_BASE_URL: 'https://api.evstai.com',
    PEXELS_API_KEY: 'pexels-key',
  })
  assert.deepEqual(withoutGatewayCredentials(fileEnv), {
    PEXELS_API_KEY: 'pexels-key',
  })
})
