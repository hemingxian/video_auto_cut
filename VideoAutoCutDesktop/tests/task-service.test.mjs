import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createTaskService } from '../dist-electron/task-service.js'
import { readTaskOutputFormat, resolveTaskOutputFormat, taskOutputFormat } from '../dist-electron/task-output-format.js'
import { validateTaskMaterialMode } from '../dist-electron/task-material-mode.js'
import { readVoiceScriptSource, writeVoiceScriptBody } from '../dist-electron/voice-script-body.js'

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 1234
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.killed = false
  child.kill = () => true
  return child
}

test('output resolution requires engine support and valid aspect combinations, with 1080p compatibility', async () => {
  function engine(help) {
    const launches = []
    return { launches, service: createTaskService({
      getVideoAutoRoot: () => 'runtime', getExePath: () => 'engine',
      createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
      readEngineHelp: () => help, send: () => {}, spawnProcess: (input) => { launches.push(input); return fakeChild() },
    }) }
  }
  for (const [aspectRatio, outputResolution] of [['16:9', '720p'], ['16:9', '4k'], ['9:16', '4k']]) {
    const old = engine('--aspect-ratio')
    assert.equal((await old.service.start({ aspectRatio, outputResolution })).ok, false)
    assert.equal(old.launches.length, 0)
    const current = engine('--aspect-ratio --output-resolution')
    assert.equal((await current.service.start({ aspectRatio, outputResolution })).ok, true)
    assert.deepEqual(current.launches[0].args, ['--aspect-ratio', aspectRatio, '--output-resolution', outputResolution])
  }
  const oldDefault = engine('--aspect-ratio')
  assert.equal((await oldDefault.service.start({ aspectRatio: '16:9', outputResolution: '1080p' })).ok, true)
  assert.deepEqual(oldDefault.launches[0].args, ['--aspect-ratio', '16:9'])
  for (const [aspectRatio, outputResolution] of [['9:16', '720p'], ['4:3', '4k'], ['3:4', '4k'], ['16:9', '8k']]) {
    assert.equal((await engine('--aspect-ratio --output-resolution').service.start({ aspectRatio, outputResolution })).ok, false)
  }
})

test('saved resolutions restore exactly, legacy files default to 1080p and resume cannot change dimensions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-output-res-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'output-format.json')
  const shotsJson = path.join(root, 'shots.json')
  fs.writeFileSync(file, JSON.stringify({ aspect_ratio: '9:16', resolution: '4k', width: 2160, height: 3840 }))
  assert.deepEqual(readTaskOutputFormat(root), taskOutputFormat('9:16', '4k'))
  assert.deepEqual(resolveTaskOutputFormat({ shotsJson }), taskOutputFormat('9:16', '4k'))
  assert.deepEqual(resolveTaskOutputFormat({ resumeRunPath: root }), taskOutputFormat('9:16', '4k'))
  assert.throws(() => resolveTaskOutputFormat({ resumeRunPath: root, outputResolution: '1080p' }), /断点续跑/)
  assert.throws(() => resolveTaskOutputFormat({ resumeRunPath: root, aspectRatio: '16:9' }), /断点续跑/)
  fs.writeFileSync(file, JSON.stringify({ aspect_ratio: '4:3', width: 1440, height: 1080 }))
  assert.equal(readTaskOutputFormat(root).outputResolution, '1080p')
  fs.writeFileSync(file, JSON.stringify({ aspect_ratio: '16:9', resolution: '4k', width: 3840, height: 210 }))
  assert.throws(() => readTaskOutputFormat(root), /不一致/)
})

test('aspect ratio requires a capable engine and is passed as a task argument', async () => {
  let launched
  let help = ''
  const service = createTaskService({
    getVideoAutoRoot: () => 'runtime', getExePath: () => 'engine',
    createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
    readEngineHelp: () => help, send: () => {},
    spawnProcess: (options) => { launched = options; return fakeChild() },
  })
  assert.equal((await service.start({ aspectRatio: '1:1' })).ok, false)
  assert.equal((await service.start({ aspectRatio: '9:16' })).ok, false)
  assert.equal(launched, undefined)
  // A new service reflects an updated executable (help is cached per instance).
  help = '--aspect-ratio'
  const updated = createTaskService({
    getVideoAutoRoot: () => 'runtime', getExePath: () => 'updated-engine',
    createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
    readEngineHelp: () => help, send: () => {},
    spawnProcess: (options) => { launched = options; return fakeChild() },
  })
  assert.equal((await updated.start({ aspectRatio: '9:16' })).ok, true)
  assert.deepEqual(launched.args, ['--aspect-ratio', '9:16'])
})

test('task launch preserves the project name when continuing from storyboard JSON', async () => {
  let launched
  const service = createTaskService({
    getVideoAutoRoot: () => 'D:\\runtime',
    getExePath: () => 'VideoAuto.exe',
    createVideoAutoEnv: () => ({ ...process.env }),
    isRuntimeUsable: () => true,
    readEngineHelp: () => '--shots-json --project-name --material-manifest',
    send: () => undefined,
    spawnProcess: (options) => {
      launched = options
      const child = fakeChild()
      queueMicrotask(() => {
        options.send(options.channel, { type: 'close', code: 0 })
        options.onClose?.(0)
      })
      return child
    },
  })

  const started = await service.start({
    shotsJson: 'D:\\workspace\\shots.json',
    projectName: '上下料B端视频',
  })
  assert.equal(started.ok, true)
  assert.deepEqual(launched.args, [
    '--shots-json',
    'D:\\workspace\\shots.json',
    '--project-name',
    '上下料B端视频',
  ])
})

test('task launch remains compatible with a runtime that predates optional project naming', async () => {
  let launched
  const service = createTaskService({
    getVideoAutoRoot: () => 'D:\\runtime',
    getExePath: () => 'VideoAuto.exe',
    createVideoAutoEnv: () => ({ ...process.env }),
    isRuntimeUsable: () => true,
    readEngineHelp: () => '--shots-json --material-manifest',
    send: () => undefined,
    spawnProcess: (options) => {
      launched = options
      return fakeChild()
    },
  })

  const started = await service.start({
    shotsJson: 'D:\\workspace\\shots.json',
    projectName: '上下料B端视频',
  })
  assert.equal(started.ok, true)
  assert.deepEqual(launched.args, ['--shots-json', 'D:\\workspace\\shots.json'])
})

test('resume normalizes historical namespace paths and joins shots.json in the main process', async () => {
  for (const [resumeRunPath, expectedRunPath] of [
    ['\\\\?\\D:\\workspace\\runs\\run-drive', 'D:\\workspace\\runs\\run-drive'],
    ['\\\\?\\UNC\\server\\share\\runs\\run-unc', '\\\\server\\share\\runs\\run-unc'],
  ]) {
    let launched
    const service = createTaskService({
      getVideoAutoRoot: () => 'D:\\runtime',
      getExePath: () => 'VideoAuto.exe',
      createVideoAutoEnv: () => ({}),
      isRuntimeUsable: () => true,
      readEngineHelp: () => '--resume-run --shots-json',
      send: () => undefined,
      spawnProcess: (options) => { launched = options; return fakeChild() },
    })

    const started = await service.start({ resumeRunPath, shotsJson: `${resumeRunPath}/shots.json` })
    assert.equal(started.ok, true)
    assert.deepEqual(launched.args, [
      '--resume-run', expectedRunPath,
      '--shots-json', path.join(expectedRunPath, 'shots.json'),
    ])
  }
})

test('generation is blocked with an actionable message when the runtime lacks a required contract', async () => {
  let launches = 0
  const service = createTaskService({
    getVideoAutoRoot: () => 'D:\\runtime',
    getExePath: () => 'VideoAuto.exe',
    createVideoAutoEnv: () => ({ ...process.env }),
    isRuntimeUsable: () => true,
    readEngineHelp: () => '--shots-json',
    send: () => undefined,
    spawnProcess: () => {
      launches += 1
      return fakeChild()
    },
  })

  const started = await service.start({
    shotsJson: 'D:\\workspace\\shots.json',
    materialManifestPath: 'D:\\workspace\\manifest.json',
  })
  assert.equal(started.ok, false)
  assert.match(started.message, /运行环境版本过旧/)
  assert.equal(launches, 0)
})

test('Step4 D9 confirmed voice body is written as exact UTF-8 and read through BOM-aware source parsing', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-voice-body-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'voice.md')
  const sourceText = '# 标题\n第一段中文。\n第二段 punctuation!'
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sourceText, 'utf8')]))
  assert.equal(await readVoiceScriptSource(source), sourceText)

  const bodyText = '第一段中文。\n第二段 punctuation!'
  const dataRoot = path.join(directory, 'data')
  const firstBodyPath = writeVoiceScriptBody(dataRoot, source, bodyText, 'task-a')
  const secondBodyPath = writeVoiceScriptBody(dataRoot, source, '同脚本的第二个任务', 'task-b')
  assert.equal(firstBodyPath, path.join(dataRoot, 'temp', 'voice_script_body_task-a.txt'))
  assert.equal(secondBodyPath, path.join(dataRoot, 'temp', 'voice_script_body_task-b.txt'))
  assert.notEqual(firstBodyPath, secondBodyPath)
  assert.deepEqual(fs.readFileSync(firstBodyPath), Buffer.from(bodyText, 'utf8'))
  assert.deepEqual(fs.readFileSync(secondBodyPath), Buffer.from('同脚本的第二个任务', 'utf8'))
})

test('Step4 task service forwards voice body and fails closed for missing files or old engine help', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-voice-task-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bodyPath = path.join(directory, 'body.txt')
  fs.writeFileSync(bodyPath, '逐字口播正文', 'utf8')
  const scriptPath = 'D:\\scripts\\voice.md'

  function fixture(help) {
    const launches = []
    return { launches, service: createTaskService({
      getVideoAutoRoot: () => 'D:\\runtime', getExePath: () => 'VideoAuto.exe',
      createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
      readEngineHelp: () => help, send: () => undefined,
      spawnProcess: (options) => { launches.push(options); return fakeChild() },
    }) }
  }

  const supported = fixture('--script-file --voice-script-body')
  const started = await supported.service.start({ scriptPath, voiceScriptBodyPath: bodyPath, planOnly: true })
  assert.equal(started.ok, true)
  assert.deepEqual(supported.launches[0].args, [
    '--script-file', scriptPath, '--voice-script-body', bodyPath, '--plan-only',
  ])

  const missing = fixture('--voice-script-body')
  const missingResult = await missing.service.start({ scriptPath, voiceScriptBodyPath: path.join(directory, 'missing.txt') })
  assert.deepEqual(missingResult, { ok: false, message: '口播正文文件已不存在，请重新选择脚本' })
  assert.equal(missing.launches.length, 0)

  const oldRuntime = fixture('--script-file')
  const unsupported = await oldRuntime.service.start({ scriptPath, voiceScriptBodyPath: bodyPath })
  assert.deepEqual(unsupported, { ok: false, message: '当前生成引擎不支持口播稿模式，请先更新运行环境' })
  assert.equal(oldRuntime.launches.length, 0)
})

test('Pexels task registers downloads before clipping and finalizes recovery on close', async () => {
  const calls = []
  const service = createTaskService({
    getVideoAutoRoot: () => 'D:\\runtime',
    getExePath: () => 'VideoAuto.exe',
    createVideoAutoEnv: () => ({ ...process.env }),
    isRuntimeUsable: () => true,
    send: () => undefined,
    onDownloadedMaterials: async (runPath, options) => {
      calls.push({ runPath, options })
    },
    spawnProcess: (options) => {
      const child = fakeChild()
      queueMicrotask(() => {
        options.send(options.channel, {
          type: 'stdout',
          text: '运行目录: D:\\workspace\\video\\runs\\run-01\n',
        })
        options.send(options.channel, {
          type: 'stdout',
          text: 'VACUT_EVENT:{"workflowStage":"clip","workflowProgress":{"stage":"clip","status":"running","phase":"stage"}}\n',
        })
        options.send(options.channel, {
          type: 'stdout',
          text: 'VACUT_EVENT:{"workflowStage":"clip","workflowProgress":{"stage":"clip","status":"running","phase":"completed_item"}}\n',
        })
        options.send(options.channel, { type: 'close', code: 0 })
        options.onClose?.(0)
      })
      return child
    },
  })

  const started = await service.start({ source: 'pexels', downloadNewMaterials: true })
  assert.equal(started.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls, [
    {
      runPath: 'D:\\workspace\\video\\runs\\run-01',
      options: { markIndexedReady: false, analyzeMissing: false },
    },
    {
      runPath: 'D:\\workspace\\video\\runs\\run-01',
      options: { markIndexedReady: true, analyzeMissing: false },
    },
    {
      runPath: 'D:\\workspace\\video\\runs\\run-01',
      options: { markIndexedReady: true, analyzeMissing: true },
    },
  ])
})

test('default material source still registers platform downloads', async () => {
  const calls = []
  const service = createTaskService({
    getVideoAutoRoot: () => 'D:\\runtime',
    getExePath: () => 'VideoAuto.exe',
    createVideoAutoEnv: () => ({ ...process.env }),
    isRuntimeUsable: () => true,
    send: () => undefined,
    onDownloadedMaterials: async (runPath, options) => {
      calls.push({ runPath, options })
    },
    spawnProcess: (options) => {
      const child = fakeChild()
      queueMicrotask(() => {
        options.send(options.channel, {
          type: 'stdout',
          text: '运行目录: D:\\workspace\\video\\runs\\run-default\n',
        })
        options.send(options.channel, {
          type: 'stdout',
          text: 'VACUT_EVENT:{"workflowStage":"clip","workflowProgress":{"stage":"clip","status":"running","phase":"completed_item"}}\n',
        })
        options.send(options.channel, { type: 'close', code: 0 })
        options.onClose?.(0)
      })
      return child
    },
  })

  const started = await service.start({ source: '', downloadNewMaterials: true })
  assert.equal(started.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.length, 3)
  assert.equal(calls.at(-1).options.analyzeMissing, true)
})

test('generation task reports reliable lifecycle progress using the frozen cloud run id', async () => {
  const statuses = []
  const service = createTaskService({
    getVideoAutoRoot: () => 'D:\\runtime',
    getExePath: () => 'VideoAuto.exe',
    createVideoAutoEnv: () => ({ ...process.env }),
    isRuntimeUsable: () => true,
    readEngineHelp: () => '--material-manifest',
    send: () => undefined,
    onGenerationStatus: (value) => { statuses.push(value) },
    spawnProcess: (options) => {
      const child = fakeChild()
      queueMicrotask(() => {
        options.send(options.channel, {
          type: 'stdout',
          text: 'VACUT_EVENT:{"workflowStage":"compose","workflowPlan":["material","clip","compose"],"workflowProgress":{"stage":"compose","status":"running","current":1,"total":2}}\n',
        })
        options.send(options.channel, { type: 'close', code: 0 })
        options.onClose?.(0)
      })
      return child
    },
  })

  const started = await service.start({
    materialManifestPath: 'D:\\workspace\\manifests\\run_cloud_12345.json',
  })
  assert.equal(started.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(statuses[0], {
    runId: 'run_cloud_12345',
    status: 'running',
    stage: 'starting',
    progress: 0,
  })
  assert.equal(statuses[1].runId, 'run_cloud_12345')
  assert.equal(statuses[1].status, 'running')
  assert.equal(statuses[1].stage, 'compose')
  assert.ok(statuses[1].progress > 0 && statuses[1].progress < 100)
  assert.deepEqual(statuses[2], {
    runId: 'run_cloud_12345',
    status: 'succeeded',
    stage: 'done',
    progress: 100,
  })
})


test('resume and full regeneration are explicit engine arguments and unsupported engines are rejected', async () => {
  for (const options of [{ resumeRunPath: 'D:/workspace/run_original' }, { restartAll: true }]) {
    let launched
    let help = '--shots-json'
    const service = createTaskService({
      getVideoAutoRoot: () => 'D:/runtime', getExePath: () => 'engine.exe',
      createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
      readEngineHelp: () => help, send: () => undefined,
      spawnProcess: (input) => { launched = input; return fakeChild() },
    })
    assert.equal((await service.start(options)).ok, false)
    assert.equal(launched, undefined)
    // Help is intentionally cached for each executable; use a new service for an updated engine.
    const supported = createTaskService({
      getVideoAutoRoot: () => 'D:/runtime', getExePath: () => 'new-engine.exe',
      createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
      readEngineHelp: () => '--shots-json --resume-run --restart-all', send: () => undefined,
      spawnProcess: (input) => { launched = input; return fakeChild() },
    })
    assert.equal((await supported.start({ ...options, shotsJson: 'D:/workspace/run_original/shots.json' })).ok, true)
    assert.ok(launched.args.includes(options.restartAll ? '--restart-all' : '--resume-run'))
    if (options.resumeRunPath) assert.ok(launched.args.includes(options.resumeRunPath))
  }
})

test('Pexels-only storyboard continuation records its actual source even without a material manifest', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-history-start-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const preview = path.join(directory, 'preview')
  const generated = path.join(directory, 'generated')
  fs.mkdirSync(preview)
  fs.mkdirSync(generated)
  const shotsJson = path.join(preview, 'shots.json')
  fs.writeFileSync(shotsJson, JSON.stringify({ shots: [{ shot_id: 'one', download_material: true, material_bindings: [] }] }))
  const service = createTaskService({
    getVideoAutoRoot: () => directory, getExePath: () => 'engine',
    createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true, readEngineHelp: () => '--shots-json',
    send: () => {}, spawnProcess: (options) => {
      queueMicrotask(() => options.send(options.channel, { type: 'stdout', text: `运行目录: ${generated}\n` }))
      return fakeChild()
    },
  })
  assert.equal((await service.start({ shotsJson, materialSourceMode: 'pexels-only' })).ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  const history = JSON.parse(fs.readFileSync(path.join(generated, 'run_history.json'), 'utf8'))
  assert.equal(history.run_id, 'generated')
  assert.equal(history.source_shots_path, fs.realpathSync.native(shotsJson))
  assert.equal(fs.existsSync(path.join(generated, 'material_manifest.json')), false)
})

test('task status identifies source shots and resume target before the engine announces its directory', async () => {
  const service = createTaskService({
    getVideoAutoRoot: () => 'runtime', getExePath: () => 'engine',
    createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
    readEngineHelp: () => '--shots-json --resume-run', send: () => {}, spawnProcess: () => fakeChild(),
  })
  const resumeRunPath = path.resolve('runs', 'resume_target')
  const shotsJson = path.join(resumeRunPath, 'shots.json')
  const result = await service.start({ resumeRunPath, shotsJson })
  assert.equal(result.ok, true)
  assert.equal(result.runPath, resumeRunPath)
  assert.equal(result.runId, 'resume_target')
  assert.equal(service.status().shotsJson, shotsJson)
})

test('edited resume reports the newly frozen cloud generation while keeping the original local run', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-edited-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runPath = path.join(directory, 'run_original')
  fs.mkdirSync(runPath)
  const shotsJson = path.join(runPath, 'shots.json')
  fs.writeFileSync(shotsJson, JSON.stringify({ shots: [{ shot_id: 'one', download_material: true, material_bindings: [] }] }))
  fs.writeFileSync(path.join(runPath, 'incremental.json'), '{"schema_version":1}')
  fs.writeFileSync(path.join(runPath, 'material-source-mode.json'), '{"material_source_mode":"library-only"}')
  const materialManifestPath = path.join(directory, 'run_new_generation.json')
  fs.writeFileSync(materialManifestPath, JSON.stringify({ schema_version: 1, run_id: 'run_new_generation', task_id: 'run_original', task_revision: 2 }))
  fs.copyFileSync(materialManifestPath, path.join(runPath, 'material_manifest.json'))
  assert.throws(() => validateTaskMaterialMode({ resumeRunPath: runPath, shotsJson,
    materialManifestPath: path.join(runPath, 'material_manifest.json'), materialSourceMode: 'pexels-only' }), /模式已改变/)
  const statuses = []
  const service = createTaskService({
    getVideoAutoRoot: () => directory, getExePath: () => 'engine', createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
    readEngineHelp: () => '--resume-run --material-manifest', send: () => {}, spawnProcess: () => fakeChild(),
    onGenerationStatus: (value) => statuses.push(value),
  })
  const started = await service.start({ resumeRunPath: runPath, shotsJson, materialManifestPath, materialSourceMode: 'pexels-only' })
  assert.equal(started.ok, true)
  assert.equal(started.runId, 'run_original')
  assert.equal(started.runPath, runPath)
  assert.equal(statuses[0].runId, 'run_new_generation')
})

function materialModeFixture(t, shots = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-material-mode-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runPath = path.join(directory, 'run_mode_test')
  fs.mkdirSync(runPath)
  const shotsJson = path.join(runPath, 'shots.json')
  fs.writeFileSync(shotsJson, JSON.stringify({ shots }))
  const events = []
  const launches = []
  function service(outputRunPath = runPath) {
    return createTaskService({
      getVideoAutoRoot: () => directory, getExePath: () => 'engine.exe',
      createVideoAutoEnv: () => ({}), isRuntimeUsable: () => true,
      readEngineHelp: () => '--shots-json --resume-run --restart-all --material-manifest',
      send: (_channel, event) => events.push(event),
      spawnProcess: (input) => {
        launches.push(input)
        queueMicrotask(() => input.send(input.channel, {
          type: 'stdout', text: `运行目录: ${outputRunPath}\n`,
        }))
        return fakeChild()
      },
    })
  }
  return { runPath, shotsJson, events, launches, service }
}

test('library-only cannot launch with downloadable or unbound shots', async (t) => {
  for (const shots of [
    [{ title: '需要下载', download_material: true, material_bindings: [] }],
    [{ title: '没有绑定', download_material: false, material_bindings: [] }],
    [],
  ]) {
    const fixture = materialModeFixture(t, shots)
    const result = await fixture.service().start({
      shotsJson: fixture.shotsJson, materialSourceMode: 'library-only',
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /重新准备素材/)
    assert.equal(fixture.launches.length, 0)
  }
})

test('Pexels-only rejects material bindings and pins the provider for valid prepared shots', async (t) => {
  const fixture = materialModeFixture(t, [{
    title: '手工绑定', download_material: false,
    material_bindings: [{ binding_type: 'material', material_id: 'asset_1' }],
  }])
  const blocked = await fixture.service().start({ shotsJson: fixture.shotsJson, materialSourceMode: 'pexels-only' })
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /仅 Pexels.*手工绑定.*重新准备素材/)
  assert.equal(fixture.launches.length, 0)
  fs.writeFileSync(fixture.shotsJson, JSON.stringify({ shots: [{ title: '下载', download_material: true }] }))
  const started = await fixture.service().start({
    shotsJson: fixture.shotsJson, materialSourceMode: 'pexels-only', source: 'pixabay',
  })
  assert.equal(started.ok, true)
  const args = fixture.launches[0].args
  assert.equal(args[args.indexOf('--source') + 1], 'pexels')
})

test('task material mode survives engine shot rewriting and blocks a different mode on resume', async (t) => {
  const fixture = materialModeFixture(t, [{
    title: '素材库镜头', download_material: false,
    material_bindings: [{ binding_type: 'material', material_id: 'asset_1' }],
  }])
  const started = await fixture.service().start({ shotsJson: fixture.shotsJson, materialSourceMode: 'library-only' })
  assert.equal(started.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  const modeFile = path.join(fixture.runPath, 'material-source-mode.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(modeFile, 'utf8')), {
    schema_version: 1, material_source_mode: 'library-only',
  })
  // Engine rewriting is independent of the desktop-owned mode record.
  fs.writeFileSync(fixture.shotsJson, JSON.stringify({ shots: [{ download_material: true }] }))
  const resumed = await fixture.service().start({
    resumeRunPath: fixture.runPath, materialSourceMode: 'pexels-only',
  })
  assert.equal(resumed.ok, false)
  assert.match(resumed.message, /素材来源模式已改变.*重新生成全部/)
  assert.equal(fixture.launches.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(modeFile, 'utf8')).material_source_mode, 'library-only')
})

test('resume validates original shots when no shots path is supplied and remains compatible without an old mode file', async (t) => {
  const fixture = materialModeFixture(t, [{ download_material: true, material_bindings: [] }])
  const blocked = await fixture.service().start({ resumeRunPath: fixture.runPath, materialSourceMode: 'library-only' })
  assert.equal(blocked.ok, false)
  assert.equal(fixture.launches.length, 0)
  const resumed = await fixture.service().start({ resumeRunPath: fixture.runPath, materialSourceMode: 'pexels-only' })
  assert.equal(resumed.ok, true)
})

test('planning skips material binding validation and mode persistence errors are reported without crashing output', async (t) => {
  const fixture = materialModeFixture(t)
  const badRunPath = path.join(fixture.runPath, 'missing', 'run_not_created')
  const started = await fixture.service(badRunPath).start({
    scriptPath: 'script.xlsx', planOnly: true, materialSourceMode: 'library-only',
  })
  assert.equal(started.ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fixture.events.some((event) => event.type === 'stderr' && /无法保存本任务的素材来源模式/.test(event.text)))
  assert.ok(fixture.events.some((event) => event.type === 'stdout' && event.runPath === badRunPath))
})

test('strict material modes fail closed if prepared shots cannot be read, while library-first allows its mixed contract', async (t) => {
  const fixture = materialModeFixture(t)
  fs.writeFileSync(fixture.shotsJson, '{')
  const result = await fixture.service().start({ shotsJson: fixture.shotsJson, materialSourceMode: 'library-only' })
  assert.equal(result.ok, false)
  assert.match(result.message, /无法读取.*重新准备素材/)
  const mixed = await fixture.service().start({ shotsJson: fixture.shotsJson, materialSourceMode: 'library-first', source: 'pixabay' })
  assert.equal(mixed.ok, true)
  assert.equal(fixture.launches[0].args.at(-1), 'pexels')
})
