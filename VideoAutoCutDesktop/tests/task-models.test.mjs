import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import {
  acknowledgeShotWarning,
  bodyReviewGate,
  confirmShotReview,
  derivedReviewStatus,
  isScriptFieldModified,
  parseShotsJson,
  pendingBodyReviewShots,
  pendingBodyReviewMessage,
  pendingReviewCount,
  readFieldOrigin,
  readScriptMeta,
  readScriptSource,
  restoreScriptValue,
  updateShotContent,
  updateShotScriptMeta,
} from '../src/pages/start/shotPlan.ts'
import {
  buildVoiceScriptBody,
  supportsVoiceScript,
  voiceScriptParagraphs,
  voiceScriptImportDecision,
  VOICE_SCRIPT_DISABLED_HINT,
} from '../src/pages/start/voiceScriptBody.ts'
import { groupArtifacts } from '../src/pages/runs/artifacts.ts'
import { groupRunHistory, isRunInUse } from '../src/pages/runs/runHistoryModel.ts'
import { normalizeOutputResolution, outputResolutions, outputSizeLabel } from '../src/pages/start/outputFormatModel.ts'
import { prepareResumeGeneration } from '../src/pages/start/resumeGeneration.ts'
import { isCompletedPlanOnlyRun } from '../src/pages/start/historyRestore.ts'
import { createHash } from 'node:crypto'
import { buildShotMaterialBoard } from '../src/pages/start/shotArtifacts.ts'
import { createWorkspaceService } from '../dist-electron/workspace-service.js'
import { registerFileReadHandler } from '../dist-electron/ipc-file-read.js'
import { notifyTaskClose, taskResultToast } from '../src/pages/start/taskCloseNotice.ts'
import './script-reveal.test.mjs'

test('S4 blocked imports and failures do not use the green success toast', async (t) => {
  const page = fs.readFileSync(new URL('../src/pages/StartPage.tsx', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('../src/components/AppToast.css', import.meta.url), 'utf8')
  assert.match(page, /TaskResultToast message=\{task\.toast\} tone=\{task\.toastTone\}/)
  assert.match(styles, /\.saved-toast\.is-error/)
  assert.equal(taskResultToast('plan', undefined, undefined, 2, 1), '脚本导入被拦下，请查看问题详情。')
  const failed = []
  await notifyTaskClose(async () => { throw new Error('shots missing') }, (...args) => failed.push(args), '脚本导入被拦下，请查看问题详情。', true)
  assert.deepEqual(failed, [['脚本导入被拦下，请查看问题详情。', 'error']])
  const succeeded = []
  await notifyTaskClose(async () => ({}), (...args) => succeeded.push(args), '分镜已整理好，可以继续生成视频。', false)
  assert.deepEqual(succeeded, [['分镜已整理好，可以继续生成视频。', 'success']])

  const require = createRequire(import.meta.url)
  const moduleApi = require('node:module')
  const previousTsx = moduleApi._extensions['.tsx']
  moduleApi._extensions['.tsx'] = (module, filename) => module._compile(ts.transpileModule(
    fs.readFileSync(filename, 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } },
  ).outputText, filename)
  t.after(() => {
    if (previousTsx) moduleApi._extensions['.tsx'] = previousTsx
    else delete moduleApi._extensions['.tsx']
  })
  const { TaskResultToast } = require('../src/pages/start/TaskResultToast.tsx')
  const errorMarkup = renderToStaticMarkup(createElement(TaskResultToast, { message: '导入被拦下', tone: 'error' }))
  const successMarkup = renderToStaticMarkup(createElement(TaskResultToast, { message: '分镜已整理', tone: 'success' }))
  assert.match(errorMarkup, /saved-toast is-error/)
  assert.match(errorMarkup, /circle-alert/)
  assert.doesNotMatch(successMarkup, /is-error|circle-alert/)
  assert.match(successMarkup, /circle-check/)
})

function historyRun(id, overrides = {}) {
  return { id, projectName: '同名脚本', path: `C:/runs/${id}`, mtime: 1,
    shotsPath: `C:/runs/${id}/shots.json`, logPath: `C:/runs/${id}/run.log`, finalVideo: '', artifacts: [], ...overrides }
}

test('history restore recognizes only the frozen completed plan-only structure', () => {
  const fixtureRoot = new URL('./fixtures/history-plan-only/', import.meta.url)
  const jobPlan = JSON.parse(fs.readFileSync(new URL('job_plan.json', fixtureRoot), 'utf8'))
  const checkpoint = JSON.parse(fs.readFileSync(new URL('checkpoint.json', fixtureRoot), 'utf8'))
  const shots = JSON.parse(fs.readFileSync(new URL('shots.json', fixtureRoot), 'utf8'))
  assert.ok(shots.shots.length > 0)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, checkpoint), true)

  const generationPlan = structuredClone(jobPlan)
  generationPlan.steps.push({ id: 'clip_segments', capability: 'clip_segments' })
  assert.equal(isCompletedPlanOnlyRun(generationPlan, checkpoint), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, { ...checkpoint, steps: checkpoint.steps.slice(0, 1) }), false)
  assert.equal(isCompletedPlanOnlyRun(undefined, checkpoint), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, undefined), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, { ...checkpoint, signature: undefined }), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, { ...checkpoint, plan_hash: 'damaged' }), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, { ...checkpoint, final_path: 'C:/output/final.mp4' }), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, { ...checkpoint, steps: checkpoint.steps.map(({ name }) => ({ name })) }), false)
  assert.equal(isCompletedPlanOnlyRun(jobPlan, { ...checkpoint, steps: checkpoint.steps.toReversed() }), false)
})

test('restore controller exempts plan-only runs without a journal and preserves resume/final/restart paths', () => {
  const controller = fs.readFileSync(new URL('../src/pages/start/useStartTaskController.ts', import.meta.url), 'utf8')
  const restore = extractNamedFunction(controller, 'async function restoreRun(run: RunItem)')
  const generate = extractNamedFunction(controller, 'async function generateVideo(restartAll = false)')
  assert.match(restore, /resumable && !run\.incrementalPath/)
  assert.match(restore, /isCompletedPlanOnlyRun\(jobPlan, checkpoint\)/)
  assert.match(restore, /checkpoint\.version === 1 && !run\.finalVideo/)
  assert.match(generate, /if \(!restartAll &&/)
  assert.match(generate, /await generateVideoInternal\(restartAll\)/)
  assert.doesNotMatch(generate, /resumeRunPath/)
})

test('restore controller produces ready state for plan-only and interrupted state for generation', async () => {
  const controller = fs.readFileSync(new URL('../src/pages/start/useStartTaskController.ts', import.meta.url), 'utf8')
  const restoreSource = extractNamedFunction(controller, 'async function restoreRun(run: RunItem)')
  const fixtureRoot = new URL('./fixtures/history-plan-only/', import.meta.url)
  const jobPlan = fs.readFileSync(new URL('job_plan.json', fixtureRoot), 'utf8')
  const checkpoint = fs.readFileSync(new URL('checkpoint.json', fixtureRoot), 'utf8')

  async function restore(overrides = {}, files = {}) {
    const progress = []
    const run = historyRun('restored', overrides)
    const context = {
      runningRef: { current: false }, generationPreparingRef: { current: false },
      showToast: () => undefined, shotPlan: { dirty: false }, saveShots: async () => true,
      selectedQueueIdRef: { current: 'old' }, setSelectedQueueId: () => undefined,
      currentTaskRef: { current: null }, setCurrentTask: () => undefined,
      loadAndApplyShotPlan: async () => ({ shots: [{}] }),
      api: { readFile: async (file) => {
        if (file.endsWith('/checkpoint.json')) {
          if (Object.hasOwn(files, 'checkpoint')) {
            if (files.checkpoint === undefined) throw new Error('missing')
            return files.checkpoint
          }
          return checkpoint
        }
        if (file.endsWith('/job_plan.json')) {
          if (Object.hasOwn(files, 'jobPlan')) {
            if (files.jobPlan === undefined) throw new Error('missing')
            return files.jobPlan
          }
          return jobPlan
        }
        throw new Error('missing')
      } },
      isCompletedPlanOnlyRun, workflowProgressRef: { current: null },
      setWorkflowProgress: (value) => progress.push(value), workflowStageRef: { current: 'old' },
      setWorkflowStage: () => undefined, setTaskStage: () => undefined,
      taskStageRef: { current: 'plan' }, followRunningQueueRef: { current: true }, setShotDrawerOpen: () => undefined,
      JSON, Boolean, String,
    }
    const entry = executeControllerEntry([], restoreSource, context)
    assert.equal(await entry(run), true)
    return progress.at(-1)
  }

  assert.equal(await restore(), undefined)
  const readyView = buildStartTaskViewModel({ scriptCount: 0, logs: [], running: false,
    selectedQueueItem: null, taskStage: 'generate',
    shotPlan: { currentRun: historyRun('ready'), shots: [{}], planRoot: {}, planOrigin: 'current', dirty: false },
    workflowProgress: undefined,
  })
  assert.equal(readyView.generateButtonText, '继续生成视频')
  assert.equal(readyView.taskStatusLabel, '当前方案')
  assert.equal(readyView.viewWorkflowFailed, false)
  assert.equal((await restore({ incrementalPath: 'C:/runs/restored/incremental.json' })).phase, 'interrupted')
  const generation = JSON.parse(jobPlan)
  generation.steps.push({ id: 'clip_segments', capability: 'clip_segments' })
  assert.equal((await restore({}, { jobPlan: JSON.stringify(generation) })).phase, 'interrupted')
  assert.equal(await restore({ finalVideo: 'C:/runs/restored/final.mp4' }), undefined)
  assert.equal((await restore({}, { jobPlan: '{ damaged' })).phase, 'interrupted')
  assert.equal(await restore({}, { checkpoint: undefined }), undefined)
  assert.equal(await restore({}, { checkpoint: '{ damaged' }), undefined)
})

test('ready generation omits resume preparation while interrupted and restart-all keep their routes', async () => {
  const controller = fs.readFileSync(new URL('../src/pages/start/useStartTaskController.ts', import.meta.url), 'utf8')
  const generateSource = extractNamedFunction(controller, 'async function generateVideo(restartAll = false)')
  async function invoke(button, restartAll = false) {
    const calls = []
    const context = {
      shotPlan: { currentRun: { id: 'run-1', path: 'C:/runs/run-1' } },
      queueItemsRef: { current: [] }, derived: { generateButtonText: button },
      retryGeneration: async () => calls.push(['resume']),
      generationPreparingRef: { current: false }, isAutomaticallyPreparingQueueItem: () => false,
      showToast: () => undefined, queuePausedRef: { current: false }, setQueuePaused: () => undefined,
      setGenerationPreparing: () => undefined, setPreparingRunTarget: () => undefined,
      generateVideoInternal: async (value) => calls.push(['first', value]),
    }
    const entry = executeControllerEntry([], generateSource, context)
    await entry(restartAll)
    return calls
  }
  assert.deepEqual(await invoke('继续生成视频'), [['first', false]])
  assert.deepEqual(await invoke('从失败步骤继续'), [['resume']])
  assert.deepEqual(await invoke('从失败步骤继续', true), [['first', true]])
  assert.equal(queueItemOptions({
    id: 'resume', mode: 'generate', status: 'queued', logs: [],
    resumeRunPath: 'C:/runs/interrupted', shotsJson: 'C:/runs/interrupted/shots.json', restartAll: false,
  }).resumeRunPath, 'C:/runs/interrupted')
})

test('real retry controller enqueues the original run as resumeRunPath', async () => {
  const controller = fs.readFileSync(new URL('../src/pages/start/useStartTaskController.ts', import.meta.url), 'utf8')
  const retrySource = extractNamedFunction(controller, 'async function retryGeneration()')
  const run = historyRun('interrupted')
  const queued = []
  const messages = []
  const context = {
    shotPlan: { currentRun: run, dirty: false, shots: [{ shot_id: 'one', download_material: false }], planRoot: {} },
    showToast: (message) => messages.push(message), queueItemsRef: { current: [] }, runningRef: { current: false },
    generationPreparingRef: { current: false }, saveShots: async () => true,
    blockPendingBodyReview: () => false, confirmPendingProductionReview: () => true,
    setGenerationPreparing: () => undefined, setPreparingRunTarget: () => undefined,
    api: {},
    prepareResumeGeneration: async () => ({
      draft: null, root: {}, shots: [{ shot_id: 'one', download_material: false }],
      materialManifestPath: 'C:/runs/interrupted/material_manifest.json',
    }),
    materialSourceModeRef: { current: 'library-only' }, queuePausedRef: { current: true }, setQueuePaused: () => undefined,
    enqueueQueueItems: (items) => { queued.push(...items); return true }, createShotsQueueItem,
    inferWorkflowPlanFromShots: () => ['clip', 'compose'], source: 'pexels',
    setDraftSaveStatus: () => undefined, draftRevisionsRef: { current: new Map() }, setShotPlan: () => undefined,
    scheduleTimeout: (callback) => callback(), startNextQueueItemRef: { current: () => undefined },
    Error, String,
  }
  const entry = executeControllerEntry([], retrySource, context)
  await entry()
  assert.equal(queued.length, 1, messages.join('\n'))
  assert.equal(queueItemOptions(queued[0]).resumeRunPath, run.path)
})

function extractNamedFunction(source, marker) {
  const expectedName = marker.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1]
  assert.ok(expectedName, `invalid function marker ${marker}`)
  const sourceFile = ts.createSourceFile('useStartTaskController.ts', source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let match
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === expectedName) match = node
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.ok(match, `missing ${marker}`)
  return match.getText(sourceFile)
}

function extractNamedCallback(source, name) {
  const sourceFile = ts.createSourceFile('useStartTaskController.ts', source,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let match
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const initializer = node.initializer
      match = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.ok(match, `missing callback ${name}`)
  return match.getText(sourceFile)
}

function executeControllerEntry(declarations, assignment, context) {
  const javascript = ts.transpileModule(
    `${declarations.join('\n')}\nglobalThis.__entry = ${assignment}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText
  vm.createContext(context)
  vm.runInContext(javascript, context)
  return context.__entry
}

async function executeRealSaveShots(saveShotsSource, parse, legacy) {
  const opened = parse(JSON.stringify(legacy))
  const writes = []
  const context = {
    runningRef: { current: false }, showToast: () => undefined,
    setDraftSaveStatus: () => undefined, setDraftSavedAt: () => undefined,
    setShotPlan: () => undefined,
    shotPlan: {
      currentRun: { id: 'legacy-task', shotsPath: 'legacy-shots.json' },
      planRoot: opened.root, shotTopic: opened.topic, shots: opened.shots, dirty: false,
    },
    draftRevisionsRef: { current: new Map([['legacy-task', 7]]) },
    materialSourceModeRef: { current: 'library-first' },
    queueDraftSave: async operation => operation(),
    api: {
      saveTaskDraft: async input => ({ revision: 8, updatedAt: '2026-10-08T00:00:00.000Z', snapshot: input.snapshot }),
      writeFile: async (file, text) => writes.push([file, text]),
    },
    console, Date, JSON, Map, Number, String,
  }
  vm.createContext(context)
  vm.runInContext(`${saveShotsSource}\nglobalThis.__saveShots = saveShots`, context)
  assert.equal(await context.__saveShots(false), true)
  assert.equal(writes.length, 1)
  return { opened: { ...opened.root, topic: opened.topic, shots: opened.shots }, saved: JSON.parse(writes[0][1]) }
}

function resumeFixture({ changed = false, journal = true, blocked = false,
  stableTaskId = 'original', draftRevision = 1, rootRevision = 1 } = {}) {
  const run = historyRun('original')
  const original = { schema_version: 2, task_revision: rootRevision, material_source_mode: 'library-first', shots: [
    { shot_id: 'a', voice_text: 'first', query_optimized: true, download_material: true, material_bindings: [] },
    { shot_id: 'b', voice_text: 'unchanged', query_optimized: true, download_material: true, material_bindings: [] },
  ] }
  const text = JSON.stringify(original)
  const edited = structuredClone(original)
  if (changed) { edited.shots[0].voice_text = 'edited'; edited.shots[0].query_optimized = false }
  const files = new Map([
    [run.shotsPath, JSON.stringify(edited)],
    [`${run.path}/checkpoint.json`, JSON.stringify({ version: 1, plan_hash: createHash('sha256').update(text).digest('hex') })],
    [`${run.path}/material_manifest.json`, JSON.stringify({ schema_version: 1, run_id: run.id, task_id: stableTaskId, task_revision: rootRevision, shots: [] })],
    [`${run.path}/material-source-mode.json`, JSON.stringify({ material_source_mode: 'library-first' })],
    ...(journal ? [[`${run.path}/incremental.json`, JSON.stringify({ schema_version: 1, records: {} })]] : []),
  ])
  const calls = []
  let currentDraftRevision = draftRevision
  const api = {
    readFile: async (file) => files.get(file) || '',
    writeFile: async (file, value) => { calls.push(['write', file]); files.set(file, value) },
    loadTaskDraft: async (taskId) => { calls.push(['load', taskId]); return currentDraftRevision === null ? null : { taskId, revision: currentDraftRevision } },
    saveTaskDraft: async (input) => {
      calls.push(['save', input])
      const current = currentDraftRevision ?? 0
      assert.equal(input.expectedRevision, current)
      const revision = currentDraftRevision === null ? Math.max(1, Number(input.snapshot.task_revision) || 0) : current + 1
      currentDraftRevision = revision
      return { taskId: input.taskId, revision, snapshot: input.snapshot }
    },
    autoResolveShotMaterials: async (input) => { calls.push(['resolve', input]); return { ok: !blocked, shots: input.shots, message: blocked ? '素材缺失' : '' } },
    prepareGenerationManifest: async (input) => { calls.push(['manifest', input]); return { manifestPath: 'C:/manifests/run_new_generation.json' } },
  }
  return { run, api, calls, files, original }
}

test('unchanged legacy resume reuses its frozen manifest without creating a cloud generation', async () => {
  const fixture = resumeFixture({ journal: false })
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.equal(result.changed, false)
  assert.equal(result.materialManifestPath, `${fixture.run.path}/material_manifest.json`)
  assert.deepEqual(fixture.calls, [])
})

test('edited resume refreshes changed materials, freezes the latest revision and preserves unchanged shot data', async () => {
  const fixture = resumeFixture({ changed: true })
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.equal(result.changed, true)
  assert.equal(result.materialManifestPath, 'C:/manifests/run_new_generation.json')
  assert.equal(fixture.calls.find(([operation]) => operation === 'resolve')[1].reuseUnchanged, true)
  assert.equal(result.shots[0].voice_text, 'edited')
  assert.equal(result.shots[0].query_optimized, false)
  assert.equal(result.shots[1].voice_text, 'unchanged')
  assert.equal(result.shots[1].query_optimized, true)
  assert.equal(fixture.calls.find(([operation]) => operation === 'manifest')[1].taskRevision, 2)
  assert.equal(JSON.parse(fixture.files.get(fixture.run.shotsPath)).task_revision, 2)
  assert.equal(fixture.calls.filter(([operation]) => operation === 'write')[0][1], fixture.run.shotsPath)
})

test('resume uses manifest stable task id when generation run id differs and increments revision', async () => {
  const fixture = resumeFixture({ changed: true, stableTaskId: 'import-task', draftRevision: 48, rootRevision: 48 })
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.deepEqual(fixture.calls.find(([operation]) => operation === 'load'), ['load', 'import-task'])
  const save = fixture.calls.find(([operation]) => operation === 'save')[1]
  assert.equal(save.taskId, 'import-task')
  assert.equal(save.expectedRevision, 48)
  assert.equal(save.snapshot.task_revision, 49)
  assert.equal(fixture.calls.find(([operation]) => operation === 'manifest')[1].taskId, 'import-task')
  assert.equal(result.draft.revision, 49)
  assert.equal(JSON.parse(fixture.files.get(fixture.run.shotsPath)).task_revision, 49)
})

test('resume creates missing stable task draft from store revision zero without lowering shots revision', async () => {
  const fixture = resumeFixture({ changed: true, stableTaskId: 'import-task', draftRevision: null, rootRevision: 48 })
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  const save = fixture.calls.find(([operation]) => operation === 'save')[1]
  assert.equal(save.taskId, 'import-task')
  assert.equal(save.expectedRevision, 0)
  assert.equal(save.snapshot.task_revision, 49)
  assert.equal(result.draft.revision, 49)
  assert.equal(JSON.parse(fixture.files.get(fixture.run.shotsPath)).task_revision, 49)
})

test('resume accepts embedded checkpoint task mapping and rejects disagreement with manifest', async () => {
  const fixture = resumeFixture({ changed: true, stableTaskId: 'import-task', draftRevision: 48, rootRevision: 48 })
  fixture.files.delete(`${fixture.run.path}/material_manifest.json`)
  fixture.files.set(`${fixture.run.path}/checkpoint.json`, JSON.stringify({
    version: 1,
    plan_hash: '0'.repeat(64),
    signature: `prefix|${JSON.stringify({ schema_version: 1, run_id: fixture.run.id, task_id: 'import-task' })}|suffix`,
  }))
  await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.deepEqual(fixture.calls.find(([operation]) => operation === 'load'), ['load', 'import-task'])

  const conflict = resumeFixture({ changed: true, stableTaskId: 'other-task', draftRevision: 48, rootRevision: 48 })
  conflict.files.set(`${conflict.run.path}/checkpoint.json`, JSON.stringify({
    version: 1,
    plan_hash: '0'.repeat(64),
    signature: JSON.stringify({ schema_version: 1, run_id: conflict.run.id, task_id: 'import-task' }),
  }))
  await assert.rejects(prepareResumeGeneration(conflict.api, conflict.run, 'library-first'), /任务标识冲突/)
  assert.equal(conflict.calls.length, 0)
})

test('consecutive resumes keep stable task id when each frozen manifest has a new run id', async () => {
  const fixture = resumeFixture({ changed: true, stableTaskId: 'import-task', draftRevision: 48, rootRevision: 48 })
  await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  fixture.files.set(`${fixture.run.path}/material_manifest.json`, JSON.stringify({
    schema_version: 1, run_id: 'freeze-request-two', task_id: 'import-task', task_revision: 49, shots: [],
  }))
  fixture.files.set(`${fixture.run.path}/checkpoint.json`, JSON.stringify({
    version: 1,
    plan_hash: '0'.repeat(64),
    signature: JSON.stringify({ schema_version: 1, run_id: 'freeze-request-two', task_id: 'import-task' }),
  }))
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  const saves = fixture.calls.filter(([operation]) => operation === 'save').map(([, input]) => input)
  assert.equal(saves.length, 2)
  assert.deepEqual(saves.map(input => [input.taskId, input.expectedRevision]), [
    ['import-task', 48], ['import-task', 49],
  ])
  assert.equal(result.draft.revision, 50)
})

test('unchanged resume does not read or write a draft even with distinct stable task id', async () => {
  const fixture = resumeFixture({ stableTaskId: 'import-task', draftRevision: 48, rootRevision: 48 })
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.equal(result.changed, false)
  assert.deepEqual(fixture.calls, [])
})

test('edited legacy resume stops before mutation, and unresolved materials preserve the edited draft', async () => {
  const legacy = resumeFixture({ changed: true, journal: false })
  await assert.rejects(prepareResumeGeneration(legacy.api, legacy.run, 'library-first'), /旧任务没有逐分镜记录/)
  assert.deepEqual(legacy.calls, [])
  const missing = resumeFixture({ changed: true, blocked: true })
  await assert.rejects(prepareResumeGeneration(missing.api, missing.run, 'library-first'), /素材缺失/)
  assert.equal(JSON.parse(missing.files.get(missing.run.shotsPath)).shots[0].voice_text, 'edited')
  assert.equal(missing.calls.some(([operation]) => operation === 'manifest'), false)
})

test('resume keeps completed downloaded shots when only narration or subtitles changed', async () => {
  const fixture = resumeFixture({ changed: true })
  fixture.files.set(`${fixture.run.path}/incremental.json`, JSON.stringify({ schema_version: 1, records: Object.fromEntries(fixture.original.shots.map((shot) => [`download:${shot.shot_id}`, { output: shot }])) }))
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.equal(fixture.calls.some(([operation]) => operation === 'resolve'), false)
  assert.equal(result.shots[0].voice_text, 'edited')
  assert.equal(result.shots[1].voice_text, 'unchanged')
  assert.equal(fixture.calls.find(([operation]) => operation === 'manifest')[1].shots.length, 2)
})

test('resume resolves only material changes or missing receipts, preserving full shot order', async () => {
  const fixture = resumeFixture({ changed: true })
  fixture.files.set(`${fixture.run.path}/incremental.json`, JSON.stringify({ schema_version: 1, records: { 'download:b': { output: fixture.original.shots[1] } } }))
  const edited = JSON.parse(fixture.files.get(fixture.run.shotsPath))
  edited.shots[0].download_query = 'new subject'
  fixture.files.set(fixture.run.shotsPath, JSON.stringify(edited))
  const result = await prepareResumeGeneration(fixture.api, fixture.run, 'library-first')
  assert.deepEqual(fixture.calls.find(([operation]) => operation === 'resolve')[1].shots.map((shot) => shot.shot_id), ['a'])
  assert.deepEqual(result.shots.map((shot) => shot.shot_id), ['a', 'b'])
  const modeChange = resumeFixture({ changed: true })
  modeChange.files.set(`${modeChange.run.path}/incremental.json`, JSON.stringify({ schema_version: 1, records: Object.fromEntries(modeChange.original.shots.map((shot) => [`download:${shot.shot_id}`, { output: shot }])) }))
  await prepareResumeGeneration(modeChange.api, modeChange.run, 'pexels-only')
  assert.equal(modeChange.calls.find(([operation]) => operation === 'resolve')[1].shots.length, 2)
})

test('history groups explicit continuations while retaining every process record and independent same-name runs', () => {
  const preview = historyRun('preview', { mtime: 9 })
  const completed = historyRun('generated', { sourceRunId: 'preview', mtime: 2, finalVideo: 'C:/final.mp4' })
  const failedRetry = historyRun('retry', { sourceRunId: 'generated', mtime: 3 })
  const otherScript = historyRun('other-script', { mtime: 4 })
  const independentRepeat = historyRun('independent-repeat', { mtime: 5 })
  const groups = groupRunHistory([preview, completed, failedRetry, otherScript, independentRepeat])
  assert.equal(groups.length, 3)
  const linked = groups.find((group) => group.key === preview.path)
  assert.equal(linked.latest.id, 'retry')
  assert.equal(linked.completed, true)
  assert.deepEqual(new Set(linked.records.map((run) => run.id)), new Set(['preview', 'generated', 'retry']))
  assert.equal(linked.records.find((run) => run.id === 'preview'), preview)
  assert.equal(linked.records.find((run) => run.id === 'generated').shotsPath, completed.shotsPath)
  assert.equal(groupRunHistory([preview, completed])[0].latest, completed)
  assert.equal(groupRunHistory([completed, failedRetry])[0].latest, failedRetry)
})

test('history never merges ambiguous run identifiers, dangling parents or cyclic links', () => {
  const duplicateA = historyRun('duplicate', { path: 'C:/runs/a/duplicate' })
  const duplicateB = historyRun('duplicate', { path: 'C:/runs/b/duplicate' })
  const related = historyRun('related', { sourceRunId: 'duplicate' })
  assert.equal(groupRunHistory([duplicateA, duplicateB, related]).length, 3)
  assert.equal(groupRunHistory([historyRun('orphan', { sourceRunId: 'missing' })]).length, 1)
  assert.equal(groupRunHistory([
    historyRun('a', { sourceRunId: 'b' }), historyRun('b', { sourceRunId: 'a' }), historyRun('c', { sourceRunId: 'a' }),
  ]).length, 3)
})

test('history deletion locks only the running or preparing record, including its source storyboard', () => {
  const preview = historyRun('preview')
  const generated = historyRun('generated')
  const unrelated = historyRun('unrelated')
  const running = { runId: generated.id, runPath: 'c:\\RUNS\\generated', shotsJson: '\\\\?\\C:\\runs\\preview\\shots.json' }
  assert.equal(isRunInUse(generated, [running]), true)
  assert.equal(isRunInUse(preview, [running]), true)
  assert.equal(isRunInUse(unrelated, [running]), false)
  assert.equal(isRunInUse(preview, [{ shotsJson: preview.shotsPath }]), true)
  assert.equal(isRunInUse(unrelated, [{ runId: preview.id }]), false)
  assert.equal(isRunInUse(preview, [{ runId: preview.id }]), true)
  assert.equal(isRunInUse(preview, [{ runId: preview.id, runPath: 'C:/other/preview' }]), false)
  assert.equal(isRunInUse(preview, []), false)
  assert.equal(taskFromStatus({ running: true, runId: 'generated', shotsJson: preview.shotsPath }).shotsJson, preview.shotsPath)
  assert.equal(queueItemToTask({ status: 'running', shotsJson: preview.shotsPath }).shotsJson, preview.shotsPath)
})

test('editing invalidates only the changed shot and preserves explicit material scopes', () => {
  const shot = { shot_id: 'a', voice_text: 'old', query_optimized: true, download_material: false,
    material_bindings: [{ binding_type: 'material', material_id: 'mat_a' }], material_resolution: { strategy: 'library' } }
  const changed = updateShotContent(shot, 'visual_query', 'new visual')
  assert.equal(changed.query_optimized, false)
  assert.deepEqual(changed.material_bindings, [])
  assert.equal(shot.query_optimized, true)
  assert.equal(updateShotContent(shot, 'voice_text', 'old'), shot)
  assert.deepEqual(updateShotContent({ ...shot, material_resolution: undefined }, 'visual_query', 'new').material_bindings, shot.material_bindings)
  for (const field of ['voice_text', 'subtitle', 'title', 'card_content', 'duration']) {
    const textOnly = updateShotContent(shot, field, 'edited')
    assert.equal(textOnly.query_optimized, true)
    assert.equal(textOnly.download_material, false)
    assert.deepEqual(textOnly.material_bindings, shot.material_bindings)
    assert.deepEqual(textOnly.material_resolution, shot.material_resolution)
  }
})

function templatePlanFixture() {
  return {
    schema_version: 2,
    topic: '模板任务',
    unknown_root: { keep: true },
    script_source: { route: 'template', format: 'VAC-SB-1', dictionaries: { shot_size: ['全景', '中景'] }, unknown: 'source' },
    shots: [{
      shot_id: 'template-1', shot: 1, title: '原题', voice_text: '原口播', subtitle: '原字幕', voiceover: true,
      card_content: '大字\n副行', card_layout: 'headline_sub', visual_query: '原画面', download_query: '原关键词',
      clip_requirements: '原素材要求', query_optimized: true, download_material: false,
      material_bindings: [{ binding_type: 'material', material_id: 'mat-1' }], material_resolution: { strategy: 'library', token: 'keep' },
      unknown_shot: { keep: true }, render_hints: { caption_source: 'subtitle', unknown: 'hint' },
      script_meta: {
        v: 1, visual_description: '原画面', shot_size: '全景', unknown_meta: { keep: true },
        authored: { card_content: '大字：大字\n副行：副行', unknown: 'authored' },
        script_values: { title: '原题', voice_text: '原口播', subtitle: '原字幕', card_content: '大字\n副行', card_layout: 'headline_sub', visual_description: '原画面', shot_size: '全景' },
        review: { ai_suggested: ['shot_size', 'shot_size', 'search_keywords', 'material_requirements'], confirmed: [], warnings: [{ code: 'note', field: 'shot_size', message: '核对景别' }] },
      },
    }],
  }
}

test('D1 template edits preserve snapshots and unknown plan, shot and metadata keys', () => {
  const original = templatePlanFixture()
  const parsed = parseShotsJson(JSON.stringify(original))
  const snapshots = structuredClone(readScriptMeta(parsed.shots[0]))
  let shot = updateShotContent(parsed.shots[0], 'subtitle', '人工字幕')
  shot = updateShotContent(shot, 'card_content', '人工大字\n人工副行')
  shot = updateShotContent(shot, 'card_layout', 'equal_lines')
  shot = updateShotScriptMeta(shot, 'visual_description', '人工画面')
  shot = updateShotScriptMeta(shot, 'shot_size', '中景')
  shot = confirmShotReview(shot, ['material_requirements'])
  shot = acknowledgeShotWarning(shot, 'note:shot_size')
  const saved = { ...parsed.root, topic: parsed.topic, shots: [shot] }
  const expected = structuredClone(parsed.root)
  expected.shots = [structuredClone(parsed.shots[0])]
  const expectedShot = expected.shots[0]
  expectedShot.subtitle = '人工字幕'
  expectedShot.card_content = '人工大字\n人工副行'
  expectedShot.card_layout = 'equal_lines'
  expectedShot.visual_query = '人工画面'
  expectedShot.query_optimized = false
  expectedShot.download_material = true
  expectedShot.material_bindings = []
  delete expectedShot.material_resolution
  expectedShot.render_hints.caption_source = 'subtitle'
  expectedShot.script_meta.visual_description = '人工画面'
  expectedShot.script_meta.shot_size = '中景'
  expectedShot.script_meta.review.confirmed = ['shot_size', 'material_requirements']
  expectedShot.script_meta.review.acknowledged = ['note:shot_size']
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), expected)
  assert.deepEqual(saved.shots[0].script_meta.script_values, snapshots.script_values)
  assert.deepEqual(saved.shots[0].script_meta.authored, snapshots.authored)
})

test('D2 modified markers normalize newlines and treat null and empty strings equally', () => {
  const shot = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  shot.script_meta.script_values.subtitle = null
  shot.subtitle = ''
  assert.equal(isScriptFieldModified(shot, 'subtitle'), false)
  shot.script_meta.script_values.title = '一行\r\n二行'
  shot.title = ' 一行\n二行 '
  assert.equal(isScriptFieldModified(shot, 'title'), false)
  shot.title = '人工标题'
  assert.equal(isScriptFieldModified(shot, 'title'), true)
  assert.equal(restoreScriptValue(shot, 'title').title, '一行\r\n二行')
})

test('generated template titles compare and restore as the importer-authored fallback', () => {
  const generated = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  generated.shot = 3
  generated.title = '分镜3'
  generated.script_meta.script_values.title = null
  assert.equal(isScriptFieldModified(generated, 'title'), false)
  generated.title = '人工标题'
  assert.equal(isScriptFieldModified(generated, 'title'), true)
  assert.equal(restoreScriptValue(generated, 'title').title, '分镜3')

  const authored = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  authored.title = '人工标题'
  assert.equal(isScriptFieldModified(authored, 'title'), true)
  assert.equal(restoreScriptValue(authored, 'title').title, '原题')
})

test('D3 subtitle and voice edits keep caption_source synchronized without dropping other hints', () => {
  let shot = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  shot = updateShotContent(shot, 'subtitle', '原口播')
  assert.equal(shot.render_hints.caption_source, undefined)
  assert.equal(shot.render_hints.unknown, 'hint')
  shot = updateShotContent(shot, 'subtitle', '人工字幕')
  assert.equal(shot.render_hints.caption_source, 'subtitle')
  shot = updateShotContent(shot, 'voice_text', '人工字幕')
  assert.equal(shot.render_hints.caption_source, undefined)
  assert.equal(shot.voiceover, true)
  shot = updateShotContent(shot, 'voice_text', '')
  assert.equal(shot.render_hints.caption_source, 'subtitle')
  assert.equal(shot.voiceover, false)
  const withoutSubtitle = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  delete withoutSubtitle.subtitle
  delete withoutSubtitle.render_hints.caption_source
  const voiceOnly = updateShotContent(withoutSubtitle, 'voice_text', '只改口播')
  assert.equal('subtitle' in voiceOnly, false)
  assert.equal(voiceOnly.render_hints.caption_source, undefined)
})

test('caption hints use the exact Python split whitespace rules without changing modified markers', () => {
  const equivalentToPythonSplit = [
    '甲  乙',
    '甲\n乙',
    '甲\t乙',
    '甲\u3000乙', // U+3000 is whitespace for Python str.split().
    '  甲 乙\t',
    '甲\u001c乙', // Python-only versus JavaScript \s.
    '甲\u0085乙', // Python-only versus JavaScript \s.
  ]
  for (const subtitle of equivalentToPythonSplit) {
    const shot = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
    shot.voice_text = '甲 乙'
    const changed = updateShotContent(shot, 'subtitle', subtitle)
    assert.equal(changed.render_hints.caption_source, undefined, JSON.stringify(subtitle))
  }

  const byteOrderMark = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  byteOrderMark.voice_text = '甲 乙'
  const changed = updateShotContent(byteOrderMark, 'subtitle', '甲\ufeff乙')
  assert.equal(changed.render_hints.caption_source, 'subtitle') // U+FEFF is not Python whitespace.

  const modified = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  modified.script_meta.script_values.subtitle = '甲 乙'
  modified.subtitle = '甲  乙'
  assert.equal(isScriptFieldModified(modified, 'subtitle'), true)
})

test('D4 single-line cards and automatic layout remove card_layout', () => {
  let shot = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  shot = updateShotContent(shot, 'card_content', '单行')
  assert.equal('card_layout' in shot, false)
  shot = updateShotContent({ ...shot, card_content: '第一行\n第二行', card_layout: 'headline_sub' }, 'card_layout', '')
  assert.equal('card_layout' in shot, false)
  const cannotRestore = updateShotContent({ ...shot, card_content: '单行' }, 'card_layout', 'headline_sub')
  assert.equal('card_layout' in cannotRestore, false)
})

test('D5 metadata confirmation preserves material state while visual and mapped material fields follow contract', () => {
  let shot = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  const resolution = structuredClone(shot.material_resolution)
  shot = updateShotScriptMeta(shot, 'shot_size', '中景')
  assert.deepEqual(shot.material_resolution, resolution)
  assert.equal(shot.query_optimized, true)
  assert.deepEqual(shot.script_meta.review.confirmed, ['shot_size'])
  shot = updateShotContent(shot, 'download_query', '人工关键词')
  assert.equal(shot.script_meta.search_keywords, undefined)
  assert.equal(shot.script_meta.review.confirmed.includes('search_keywords'), true)
  assert.equal(shot.query_optimized, false)
  const sameQuery = { ...parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0], visual_query: '新画面' }
  const changed = updateShotScriptMeta(sameQuery, 'visual_description', '新画面')
  assert.equal(changed.script_meta.visual_description, '新画面')
  assert.equal(changed.query_optimized, false)
  assert.equal(changed.material_resolution, undefined)
})

test('restoring an originally empty visual description keeps the importer search fallback', () => {
  let shot = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  shot.script_meta.visual_description = undefined
  shot.script_meta.script_values.visual_description = null
  shot.script_meta.search_keywords = '机械臂上料'
  shot.visual_query = '机械臂上料'
  shot = updateShotScriptMeta(shot, 'visual_description', '人工画面')
  assert.equal(shot.visual_query, '人工画面')
  shot = restoreScriptValue(shot, 'visual_description')
  assert.equal(shot.script_meta.visual_description, undefined)
  assert.equal(shot.visual_query, '机械臂上料')
  assert.notEqual(shot.visual_query, '')

  let titleFallback = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  titleFallback.script_meta.visual_description = undefined
  titleFallback.script_meta.script_values.visual_description = null
  titleFallback.script_meta.search_keywords = undefined
  titleFallback.title = '人工改题'
  titleFallback = updateShotScriptMeta(titleFallback, 'visual_description', '人工画面')
  titleFallback = restoreScriptValue(titleFallback, 'visual_description')
  assert.equal(titleFallback.visual_query, '原题')

  let generatedTitleFallback = parseShotsJson(JSON.stringify(templatePlanFixture())).shots[0]
  generatedTitleFallback.shot = 3
  generatedTitleFallback.script_meta.visual_description = undefined
  generatedTitleFallback.script_meta.script_values.visual_description = null
  generatedTitleFallback.script_meta.script_values.title = null
  generatedTitleFallback.script_meta.search_keywords = undefined
  generatedTitleFallback.title = '人工改题'
  generatedTitleFallback = updateShotScriptMeta(generatedTitleFallback, 'visual_description', '人工画面')
  generatedTitleFallback = restoreScriptValue(generatedTitleFallback, 'visual_description')
  assert.equal(generatedTitleFallback.visual_query, '分镜3')
})

test('D6 legacy plans keep their existing edit behavior and malformed template metadata is ignored safely', () => {
  const legacy = { shot_id: 'legacy', voice_text: 'old', subtitle: 'legacy subtitle', query_optimized: true, download_material: false, material_bindings: [], material_resolution: { strategy: 'library' } }
  const changed = updateShotContent(legacy, 'voice_text', '')
  assert.equal(changed.voiceover, undefined)
  assert.equal(changed.render_hints, undefined)
  assert.deepEqual(changed.material_resolution, legacy.material_resolution)
  for (const malformed of [null, [], 'bad', 7]) {
    const shot = { ...legacy, script_meta: malformed }
    assert.equal(readScriptMeta(shot), undefined)
    assert.equal(pendingReviewCount(shot), 0)
    assert.doesNotThrow(() => acknowledgeShotWarning(shot, 'x:y'))
  }
  const badReview = { ...legacy, script_meta: { review: { ai_suggested: ['shot_size', 'shot_size', {}], warnings: [{ code: {}, message: {} }, null] } } }
  assert.equal(pendingReviewCount(badReview), 0)
})

test('N4 a29 and candidate real open-save paths preserve identical legacy business data', async t => {
  const root = path.resolve(import.meta.dirname, '..')
  const controllerPath = path.join(root, 'src', 'pages', 'start', 'useStartTaskController.ts')
  const currentController = fs.readFileSync(controllerPath, 'utf8')
  const baselineController = execFileSync(
    'git', ['show', 'a29d74f:VideoAutoCutDesktop/src/pages/start/useStartTaskController.ts'],
    { cwd: path.resolve(root, '..'), encoding: 'utf8' },
  )
  const currentSave = extractNamedFunction(currentController, 'async function saveShots(showSaved = true)')
  const baselineSave = extractNamedFunction(baselineController, 'async function saveShots(showSaved = true)')

  const baselineShotPlan = execFileSync(
    'git', ['show', 'a29d74f:VideoAutoCutDesktop/src/pages/start/shotPlan.ts'],
    { cwd: path.resolve(root, '..'), encoding: 'utf8' },
  )
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-n4-a29-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const baselineModulePath = path.join(temporary, 'shotPlan.ts')
  fs.writeFileSync(baselineModulePath, baselineShotPlan, 'utf8')
  const baselineParse = (await import(`${pathToFileURL(baselineModulePath).href}?n4=a29d74f`)).parseShotsJson

  const legacy = {
    schema_version: 2, task_revision: 7, topic: '旧任务', unknown_root: { keep: [1, null, 'x'] },
    shots: [{
      shot_id: 'legacy-1', shot: 1, title: '原题', duration: 3,
      voice_text: '原口播', subtitle: '原字幕', visual_query: '原画面',
      download_material: true, material_bindings: [], unknown_shot: { keep: true },
    }],
  }
  const baseline = await executeRealSaveShots(baselineSave, baselineParse, legacy)
  const candidate = await executeRealSaveShots(currentSave, parseShotsJson, legacy)
  assert.deepEqual(baseline.opened, legacy)
  assert.deepEqual(candidate.opened, legacy)
  assert.deepEqual(candidate.saved, baseline.saved)

  for (const saved of [baseline.saved, candidate.saved]) {
    const business = structuredClone(saved)
    delete business.task_revision
    delete business.material_source_mode
    const originalBusiness = structuredClone(legacy)
    delete originalBusiness.task_revision
    assert.deepEqual(business, originalBusiness)
    assert.equal(saved.schema_version, 2)
    assert.equal(saved.task_revision, 8)
    assert.equal(saved.material_source_mode, 'library-first')
    assert.equal(Object.hasOwn(saved, 'script_source'), false)
    assert.equal(saved.shots.some(shot => Object.hasOwn(shot, 'script_meta')), false)
  }
})

test('Step4 D1 template, organized and legacy plans render one complete editor field set', (t) => {
  const template = templatePlanFixture()
  template.script_source.file_name = 'demo.xlsx'
  template.shots[0].script_meta.field_origin = { title: 'ai', card_layout: 'default' }
  const organized = structuredClone(template)
  organized.script_source = { ...organized.script_source, route: 'organized', file_name: 'essay.md' }
  organized.shots[0].script_meta.field_origin = {
    title: 'ai', voice_text: 'script', shot_size: 'default', bad: 'invented', nested: {},
  }
  const legacy = { topic: '旧任务', shots: [{
    shot_id: 'legacy-1', title: '旧标题', voice_text: '旧口播', subtitle: '旧字幕',
    card_content: '旧上屏', card_layout: 'headline_sub', visual_query: '旧画面',
    download_query: '旧搜索词', clip_requirements: '旧素材要求',
    download_material: true, material_bindings: [],
  }] }

  assert.equal(readScriptSource(template).route, 'template')
  assert.equal(readScriptSource(organized).route, 'organized')
  assert.equal(readScriptSource(legacy), undefined)
  assert.deepEqual(readFieldOrigin(organized.shots[0]), {
    title: 'ai', voice_text: 'script', shot_size: 'default',
  })
  assert.deepEqual(readFieldOrigin(legacy.shots[0]), {})

  const require = createRequire(import.meta.url)
  const moduleApi = require('node:module')
  const previousTs = moduleApi._extensions['.ts']
  const previousTsx = moduleApi._extensions['.tsx']
  const compile = (module, filename) => module._compile(ts.transpileModule(
    fs.readFileSync(filename, 'utf8'),
    { compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    } },
  ).outputText, filename)
  moduleApi._extensions['.ts'] = compile
  moduleApi._extensions['.tsx'] = compile
  t.after(() => {
    if (previousTs) moduleApi._extensions['.ts'] = previousTs
    else delete moduleApi._extensions['.ts']
    if (previousTsx) moduleApi._extensions['.tsx'] = previousTsx
    else delete moduleApi._extensions['.tsx']
  })
  const { ShotEditorDrawer } = require('../src/pages/start/ShotEditorDrawer.tsx')
  const render = (plan) => renderToStaticMarkup(createElement(ShotEditorDrawer, {
    open: true,
    topic: plan.topic,
    shots: plan.shots,
    planRoot: plan,
    dirty: false,
    draftSaveStatus: 'idle',
    draftSavedAt: '',
    currentRun: null,
    message: '',
    onClose: () => undefined,
    onSave: async () => true,
    onRefresh: async () => undefined,
    onTopicChange: () => undefined,
    onShotChange: () => undefined,
    onShotMaterialsChange: () => undefined,
  }))
  const markups = [render(template), render(organized), render(legacy)]
  const labels = [
    '分镜标题', '口播文案', '字幕', '上屏内容', '版式', '卡片提示', '画面内容',
    '景别', '运镜', '拍摄角度', '转场', '搜索关键词', '素材要求',
  ]
  for (const [sourceIndex, markup] of markups.entries()) {
    for (const label of labels) assert.equal(markup.includes(label), true, `${sourceIndex}:${label}`)
  }
  assert.match(markups[0], /标准脚本 VAC-SB-1（Excel）/)
  assert.doesNotMatch(markups[0], /template-origin/)
  assert.match(markups[1], /template-origin/)
  assert.match(markups[1], /AI 整理/)
  assert.match(markups[2], /旧任务无此信息/)
  assert.match(markups[2], /disabled=""/)
  assert.match(markups[2], /旧画面/)
  const markdownTemplate = structuredClone(template)
  markdownTemplate.script_source = { ...markdownTemplate.script_source, carrier: 'markdown', file_name: undefined }
  assert.match(render(markdownTemplate), /标准脚本 VAC-SB-1（Markdown）/)
})

test('Step4 D2 legacy card edits remove invalid layout without creating metadata or source', () => {
  const root = { topic: '旧任务', untouched: { keep: true } }
  const legacy = {
    shot_id: 'legacy-card', card_content: '第一行\n第二行', card_layout: 'headline_sub',
    download_material: true, material_bindings: [], unknown: { keep: true },
  }
  let changed = updateShotContent(legacy, 'card_content', '只剩一行')
  assert.equal(changed.card_content, '只剩一行')
  assert.equal(Object.hasOwn(changed, 'card_layout'), false)
  changed = updateShotContent(changed, 'card_layout', 'equal_lines')
  assert.equal(Object.hasOwn(changed, 'card_layout'), false)
  assert.equal(Object.hasOwn(changed, 'script_meta'), false)
  assert.equal(Object.hasOwn(root, 'script_source'), false)
  assert.deepEqual(changed.unknown, { keep: true })
})

test('Step4 D3 editing body fields confirms only fields listed by ai_suggested', () => {
  const bodyFields = ['title', 'voice_text', 'subtitle', 'card_content', 'card_layout']
  for (const field of bodyFields) {
    const shot = structuredClone(templatePlanFixture().shots[0])
    shot.script_meta.review = { ai_suggested: [field, 'visual_description'], confirmed: [] }
    const value = field === 'card_content' ? '新大字\n新副行'
      : field === 'card_layout' ? 'equal_lines' : `人工${field}`
    const changed = updateShotContent(shot, field, value)
    assert.deepEqual(changed.script_meta.review.confirmed, [field], field)
    assert.equal(changed.script_meta.review.confirmed.includes('visual_description'), false, field)
  }

  const template = structuredClone(templatePlanFixture().shots[0])
  template.script_meta.review = { ai_suggested: ['shot_size'], confirmed: [] }
  const changedTemplate = updateShotContent(template, 'title', '人工标题')
  assert.deepEqual(changedTemplate.script_meta.review.confirmed, [])
})

test('Step4 D4 generation gate blocks pending body fields and ignores production fields', () => {
  const first = structuredClone(templatePlanFixture().shots[0])
  first.shot = 4
  first.script_meta.review = {
    ai_suggested: ['title', 'voice_text', 'visual_description', 'shot_size'],
    confirmed: ['voice_text'],
  }
  const productionOnly = structuredClone(templatePlanFixture().shots[0])
  productionOnly.shot = 7
  productionOnly.script_meta.review = {
    ai_suggested: ['visual_description', 'shot_size', 'search_keywords'], confirmed: [],
  }
  const pending = pendingBodyReviewShots([first, productionOnly])
  assert.deepEqual(pending, [
    { index: 0, shot: 4, fields: ['title'] },
  ])
  assert.equal(pendingBodyReviewMessage(pending), '还有 1 镜正文未确认：第 4 镜。已跳到第一处。')
  const another = structuredClone(first)
  another.shot = 9
  assert.deepEqual(bodyReviewGate([first, productionOnly, another]), {
    blocked: true,
    pending: [
      { index: 0, shot: 4, fields: ['title'] },
      { index: 2, shot: 9, fields: ['title'] },
    ],
    firstIndex: 0,
    message: '还有 2 镜正文未确认：第 4、9 镜。已跳到第一处。',
  })
  assert.deepEqual(bodyReviewGate([productionOnly]), {
    blocked: false, pending: [], firstIndex: -1, message: '',
  })
  assert.deepEqual(pendingBodyReviewShots([productionOnly]), [])
})

test('Step4 D4 automatic continuation executes the real gate before material and manifest side effects', async () => {
  const controllerPath = path.resolve(import.meta.dirname, '../src/pages/start/useStartTaskController.ts')
  const controller = fs.readFileSync(controllerPath, 'utf8')
  const pendingShot = structuredClone(templatePlanFixture().shots[0])
  pendingShot.script_meta.review = { ai_suggested: ['title'], confirmed: [] }
  const item = { id: 'plan-item', mode: 'plan', status: 'running', logs: [], autoContinueToGenerate: true }
  const updates = []
  const calls = { autoResolve: 0, manifest: 0, saveDraft: 0, write: 0, scroll: [], toast: [] }
  const planned = {
    currentRun: { id: 'task-1', shotsPath: 'D:/runs/task-1/shots.json' },
    planRoot: { topic: '待确认计划', shots: [pendingShot] },
    shots: [pendingShot], shotTopic: '待确认计划', dirty: false,
  }
  const context = {
    bodyReviewGate,
    updateQueueItem: (id, value) => updates.push([id, value]),
    selectedQueueIdRef: { current: item.id },
    applyShotPlan: () => { calls.applied = true },
    setShotDrawerOpen: (value) => { calls.drawer = value },
    scheduleTimeout: (callback) => callback(),
    document: { getElementById: (id) => ({ scrollIntoView: () => calls.scroll.push(id) }) },
    showToast: (message) => calls.toast.push(message),
    normalizeMaterialSourceMode: () => 'library-first',
    queuePausedRef: { current: false },
    queueItemsRef: { current: [item] },
    generationPreparingRef: { current: false },
    setGenerationPreparing: () => undefined,
    setPreparingRunTarget: () => undefined,
    loadTaskShotPlan: async () => planned,
    queueItemToTask: (value) => value,
    api: {
      loadTaskDraft: async () => null,
      autoResolveShotMaterials: async () => { calls.autoResolve += 1; return { ok: true, shots: [pendingShot] } },
      prepareGenerationManifest: async () => { calls.manifest += 1; return { manifestPath: 'never' } },
      saveTaskDraft: async () => { calls.saveDraft += 1; return { revision: 1 } },
      writeFile: async () => { calls.write += 1 },
    },
    draftRevisionsRef: { current: new Map() },
    applyScriptMaterialScope: (root) => root,
    normalizeShots: (shots) => shots,
    Date, JSON, Error, Map, Set, String, Number,
  }
  const entry = executeControllerEntry(
    [`const blockPendingBodyReview = ${extractNamedCallback(controller, 'blockPendingBodyReview')}`],
    extractNamedCallback(controller, 'continueAfterAutomaticPlan'),
    context,
  )
  await entry(item)

  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [[item.id, {
    status: 'paused', autoContinueToGenerate: false,
    message: '还有 1 镜正文未确认：第 1 镜。已跳到第一处。',
  }]])
  assert.deepEqual(calls.scroll, ['shot-editor-0'])
  assert.equal(calls.drawer, true)
  assert.deepEqual(calls.toast, ['还有 1 镜正文未确认：第 1 镜。已跳到第一处。'])
  assert.deepEqual(
    { autoResolve: calls.autoResolve, manifest: calls.manifest, saveDraft: calls.saveDraft, write: calls.write },
    { autoResolve: 0, manifest: 0, saveDraft: 0, write: 0 },
  )
})

test('Step4 D4 resume executes the real gate and leaves the item paused without resuming or starting work', async () => {
  const controller = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/pages/start/useStartTaskController.ts'), 'utf8',
  )
  const pendingShot = structuredClone(templatePlanFixture().shots[0])
  pendingShot.shot = 3
  pendingShot.script_meta.review = { ai_suggested: ['card_content'], confirmed: [] }
  const item = {
    id: 'resume-item', mode: 'generate', status: 'paused', runId: 'run-1', runPath: 'D:/runs/run-1',
    logs: [], autoContinueToGenerate: false,
  }
  const updates = []
  const calls = { resume: 0, start: 0, scroll: [], toast: [] }
  const latest = {
    currentRun: { id: 'run-1', path: item.runPath, shotsPath: `${item.runPath}/shots.json` },
    planRoot: { topic: '恢复计划', shots: [pendingShot] }, shots: [pendingShot], shotTopic: '恢复计划', dirty: false,
  }
  const context = {
    bodyReviewGate,
    queueItemsRef: { current: [item] }, runningRef: { current: false }, generationPreparingRef: { current: false },
    selectedQueueIdRef: { current: item.id },
    shotPlan: { currentRun: latest.currentRun, dirty: false },
    normalizeMaterialSourceMode: () => 'library-first', materialSourceModeRef: { current: 'library-first' },
    saveShots: async () => true,
    setSelectedQueueId: () => undefined, followRunningQueueRef: { current: false },
    setGenerationPreparing: () => undefined, setPreparingRunTarget: () => undefined,
    queuePausedRef: { current: true }, setQueuePaused: () => undefined,
    updateQueueItem: (id, value) => updates.push([id, value]),
    loadTaskShotPlan: async () => latest,
    queueItemToTask: (value) => value,
    api: { loadTaskDraft: async () => null },
    normalizeShots: (shots) => shots,
    prepareResumeGeneration: async () => { calls.resume += 1; return {} },
    draftRevisionsRef: { current: new Map() }, setDraftSaveStatus: () => undefined, setShotPlan: () => undefined,
    applyShotPlan: () => { calls.applied = true }, setShotDrawerOpen: (value) => { calls.drawer = value },
    scheduleTimeout: (callback) => callback(),
    document: { getElementById: (id) => ({ scrollIntoView: () => calls.scroll.push(id) }) },
    showToast: (message) => calls.toast.push(message),
    continueAfterAutomaticPlan: async () => { calls.continued = true },
    startNextQueueItemRef: { current: () => { calls.start += 1 } },
    Date, JSON, Error, Map, Set, String, Number,
  }
  const entry = executeControllerEntry(
    [
      `const blockPendingBodyReview = ${extractNamedCallback(controller, 'blockPendingBodyReview')}`,
      extractNamedFunction(controller, 'function resumeQueueItem'),
    ],
    'resumeQueueItem',
    context,
  )
  await entry(item.id)

  assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1))), [item.id, {
    status: 'paused', autoContinueToGenerate: false,
    message: '还有 1 镜正文未确认：第 3 镜。已跳到第一处。',
  }])
  assert.deepEqual(calls.scroll, ['shot-editor-0'])
  assert.equal(calls.drawer, true)
  assert.equal(calls.resume, 0)
  assert.equal(calls.continued, undefined)
  assert.equal(calls.start, 0)
})

test('Step4 D5 review status is derived without rewriting the audit status', () => {
  const shot = structuredClone(templatePlanFixture().shots[0])
  shot.script_meta.review = {
    status: '待确认',
    ai_suggested: ['title'],
    confirmed: ['title'],
    warnings: [{ code: 'check', field: 'shot_size', message: '请核对景别' }],
    acknowledged: ['check:shot_size'],
  }
  assert.equal(derivedReviewStatus(shot), 'confirmed')
  assert.equal(shot.script_meta.review.status, '待确认')
  const pending = structuredClone(shot)
  pending.script_meta.review.acknowledged = []
  assert.equal(derivedReviewStatus(pending), 'pending')
  assert.equal(derivedReviewStatus({ shot_id: 'legacy', download_material: true, material_bindings: [] }), 'none')
})

test('Step4 D8 voice-script mode defaults off, supports only deterministic source types and follows file keys', () => {
  for (const file of ['a.txt', 'A.MD', 'C:/scripts/demo.DocX']) assert.equal(supportsVoiceScript(file), true, file)
  for (const file of ['a.xlsx', 'a.pdf', 'a.doc', 'a.md.bak', '']) assert.equal(supportsVoiceScript(file), false, file)
  assert.equal(VOICE_SCRIPT_DISABLED_HINT, '这种格式读不出确定的原文，不能用口播稿模式')

  const original = 'C:/scripts/original.md'
  const replacement = 'C:/scripts/replacement.md'
  const originalKey = scriptMaterialKey(original)
  assert.deepEqual(
    voiceScriptImportDecision([original], {}, {}, scriptMaterialKey),
    { action: 'enqueue', pending: [] },
  )
  const needsPreview = voiceScriptImportDecision(
    [original], { [originalKey]: true }, {}, scriptMaterialKey,
  )
  assert.deepEqual(needsPreview, { action: 'open-confirm', pending: [original] })
  assert.deepEqual(
    voiceScriptImportDecision(
      [original], { [originalKey]: true }, { [originalKey]: 'C:/temp/body.txt' }, scriptMaterialKey,
    ),
    { action: 'enqueue', pending: [] },
  )
  const [defaultItem] = createScriptQueueItems({
    paths: [original], mode: 'plan', materialMode: 'download', source: 'pexels',
  })
  assert.equal(defaultItem.voiceScript, undefined)
  assert.equal(defaultItem.voiceScriptBodyPath, undefined)
  const [enabled] = createScriptQueueItems({
    paths: [original], mode: 'plan', materialMode: 'download', source: 'pexels',
    voiceScriptBodyPaths: { [originalKey]: 'C:/temp/body.txt' },
  })
  assert.equal(enabled.voiceScript, true)
  assert.equal(queueItemOptions(enabled).voiceScriptBodyPath, 'C:/temp/body.txt')
  const [changedFile] = createScriptQueueItems({
    paths: [replacement], mode: 'plan', materialMode: 'download', source: 'pexels',
    voiceScriptBodyPaths: { [originalKey]: 'C:/temp/body.txt' },
  })
  assert.equal(changedFile.voiceScript, undefined)
  assert.equal(changedFile.voiceScriptBodyPath, undefined)
})

test('Step4 D9 voice body defaults exclude headings, project info, fences and short keys while preserving UTF-8 order', () => {
  const source = [
    '\uFEFF# 总标题',
    '第一段，保留。',
    '## 项目信息',
    '片名：测试片',
    '这一段也属于项目信息，不选。',
    '### 项目信息子节',
    '子节正文也不选。',
    '## 正文',
    '作者: 张三',
    '一二三四五六：短键值不选',
    '一二三四五六七：七字键不是短键值，应保留',
    '```text',
    '围栏中的正文不选',
    '```',
    '',
    '第二段，保留中文与标点！',
  ].join('\r\n')
  const paragraphs = voiceScriptParagraphs(source)
  const selected = paragraphs.filter((item) => item.selected).map((item) => item.text)
  assert.deepEqual(selected, [
    '第一段，保留。',
    '一二三四五六七：七字键不是短键值，应保留',
    '第二段，保留中文与标点！',
  ])
  const body = buildVoiceScriptBody(paragraphs)
  assert.equal(body, selected.join('\n'))
  assert.deepEqual(Buffer.from(body, 'utf8'), Buffer.from(selected.join('\n'), 'utf8'))
})

test('Step4 D9 consecutive voice files use path identity and initialize independent body paragraphs', () => {
  const dialogSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/pages/start/ScriptFilesDialog.tsx'), 'utf8',
  )
  const sourceFile = ts.createSourceFile(
    'ScriptFilesDialog.tsx', dialogSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  )
  let previewKey = null
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === 'VoiceScriptBodyDialog') {
      const key = node.attributes.properties.find((attribute) => (
        ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'key'
      ))
      if (key && key.initializer && ts.isJsxExpression(key.initializer) && key.initializer.expression) {
        previewKey = key.initializer.expression.getText(sourceFile)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.equal(previewKey, 'voicePreview.path')

  const first = voiceScriptParagraphs('# 第一份\n第一份正文。')
  const second = voiceScriptParagraphs('# 第二份\n第二份正文。')
  first.find((paragraph) => paragraph.selected).selected = false
  assert.equal(buildVoiceScriptBody(first), '')
  assert.equal(buildVoiceScriptBody(second), '第二份正文。')
})

test('Step4 D9 duration uses 4.2 non-whitespace characters per second with ceiling', () => {
  const bodySource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/pages/start/voiceScriptBody.ts'), 'utf8',
  )
  const formatDuration = executeControllerEntry(
    [extractNamedFunction(bodySource, 'function formatVoiceScriptDuration')],
    'formatVoiceScriptDuration',
    { exports: {} },
  )
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(1), '1 秒')
  assert.equal(formatDuration(42), '10 秒')
  assert.equal(formatDuration(43), '11 秒')
  assert.equal(formatDuration(252), '1 分 0 秒')
  assert.equal(formatDuration(253), '1 分 1 秒')
})

test('Step4 D10 verbatim voice is exempt but an unconfirmed title still blocks generation', () => {
  const verbatim = structuredClone(templatePlanFixture().shots[0])
  verbatim.script_meta.field_origin = { voice_text: 'script', title: 'ai' }
  verbatim.script_meta.review = {
    ai_suggested: ['title', 'visual_description'], confirmed: [],
  }
  assert.deepEqual(pendingBodyReviewShots([verbatim]), [
    { index: 0, shot: 1, fields: ['title'] },
  ])
  verbatim.script_meta.review.confirmed = ['title']
  assert.deepEqual(pendingBodyReviewShots([verbatim]), [])

  const invalid = structuredClone(verbatim)
  invalid.script_meta.review.ai_suggested = ['voice_text']
  invalid.script_meta.review.confirmed = []
  assert.deepEqual(pendingBodyReviewShots([invalid])[0].fields, ['voice_text'])
})

test('D8 production workspace and registered IPC read a real 300 KB shots.json in full', async (t) => {
  const padding = 'x'.repeat(300 * 1024)
  const plan = templatePlanFixture()
  plan.unknown_root.padding = padding
  const expectedText = JSON.stringify(plan)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-d8-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataRoot = path.join(root, 'data')
  const runsDir = path.join(dataRoot, 'runs')
  const runDir = path.join(runsDir, 'large-run')
  fs.mkdirSync(runDir, { recursive: true })
  const shotsPath = path.join(runDir, 'shots.json')
  fs.writeFileSync(shotsPath, expectedText, 'utf8')
  const workspaceService = createWorkspaceService({
    appName: 'VideoAutoCutTest', userDataRoot: root, configRoot: path.join(root, 'config'), dataRoot,
    legacyDataRoot: path.join(root, 'legacy'), envPath: path.join(root, 'config', 'app.env'), runsDir,
    defaultOutputDir: path.join(root, 'output'), materialsDir: path.join(root, 'materials'),
    voiceTemplatesDir: path.join(root, 'voices'), runtimeManifestDefaultUrl: '', getVideoAutoRoot: () => root,
  })
  assert.notEqual(workspaceService.readTextFile(shotsPath).length, expectedText.length)
  assert.equal(workspaceService.readTextFile(shotsPath, 8 * 1024 * 1024), expectedText)

  const handlers = new Map()
  registerFileReadHandler((channel, handler) => handlers.set(channel, handler), workspaceService.readTextFile)
  const ipcText = await handlers.get('file:read')({}, shotsPath, 8 * 1024 * 1024)
  assert.equal(ipcText, expectedText)
  const parsed = JSON.parse(ipcText)
  assert.equal(parsed.unknown_root.padding.length, padding.length)
})

test('final videos are separated from intermediate clips and bindings are counted independently', () => {
  const final = { kind: '视频', name: 'final.mp4', relativePath: 'output/final.mp4' }
  const clip = { kind: '视频', name: 'clip.mp4', relativePath: 'clips/clip.mp4' }
  const { groupList } = groupArtifacts([final, clip])
  assert.deepEqual(groupList.find((group) => group.kind === '成片').items, [final])
  assert.deepEqual(groupList.find((group) => group.kind === '视频').items, [clip])
  const board = buildShotMaterialBoard([{ shot_id: 'a', material_bindings: [{ binding_type: 'material', material_id: 'mat_a' }] }])
  assert.equal(board.boundShotCount, 1)
  assert.equal(board.candidateCount, 0)
})

import { basename } from '../src/lib/path.ts'
import {
  inferTaskStageFromCommand,
  inferWorkflowPlanFromShots,
  normalizeWorkflowPlan,
  normalizeWorkflowProgress,
  shouldRefreshMaterialPreview,
  shouldRefreshPlanPreview,
} from '../src/pages/start/taskEventModel.ts'
import {
  buildStartTaskViewModel,
  createScriptQueueItems,
  createShotsQueueItem,
  findQueueItemForPlan,
  isAutomaticallyPreparingQueueItem,
  normalizeScriptPaths,
  prepareQueueItemForGeneration,
  queueItemOptions,
  queueItemToTask,
  samePathList,
  taskFromStatus,
} from '../src/pages/start/taskQueueModel.ts'
import { buildTaskWorkflow } from '../src/pages/start/taskWorkflow.ts'
import { normalizeMaterialSourceMode } from '../src/pages/start/materialSourceMode.ts'

test('material source modes survive persisted plans and govern continued downloads', () => {
  for (const materialSourceMode of ['library-only', 'library-first', 'pexels-only']) {
    const [plan] = createScriptQueueItems({
      paths: ['C:/scripts/demo.xlsx'], mode: 'plan', materialMode: 'download', source: 'pixabay', materialSourceMode,
    })
    const restored = JSON.parse(JSON.stringify(plan))
    const generated = prepareQueueItemForGeneration(restored, {
      materialMode: 'download', source: 'pixabay', workflowPlan: ['query', 'material', 'clip', 'compose'],
    })
    assert.equal(generated.materialSourceMode, materialSourceMode)
    assert.equal(generated.preferLocalMaterials, materialSourceMode !== 'pexels-only')
    assert.equal(generated.downloadNewMaterials, materialSourceMode !== 'library-only')
    const options = queueItemOptions(generated)
    assert.equal(options.materialSourceMode, materialSourceMode)
    assert.equal(options.source, materialSourceMode === 'library-only' ? undefined : 'pexels')
  }
})

test('Pexels-only queues ignore bound script scopes and cannot reuse stale no-download flags', () => {
  const path = 'C:/scripts/demo.xlsx'
  const [item] = createScriptQueueItems({
    paths: [path], mode: 'generate', materialMode: 'library', source: 'pixabay', materialSourceMode: 'pexels-only',
    scriptMaterialBindings: { [scriptMaterialKey(path)]: [{ binding_type: 'folder', folder_id: 'folder', include_subfolders: true }] },
  })
  assert.deepEqual(item.scriptMaterialBindings, [])
  assert.equal(item.downloadNewMaterials, true)
  assert.equal(item.source, 'pexels')
  const reused = prepareQueueItemForGeneration({ ...item, materialManifestPath: 'old.json', scriptMaterialBindings: [{ binding_type: 'material', material_id: 'old' }] }, {
    materialMode: 'library', source: '', workflowPlan: ['clip', 'compose'], materialManifestPath: 'new-empty-materials.json',
  })
  assert.deepEqual(reused.scriptMaterialBindings, [])
  assert.equal(reused.materialManifestPath, 'new-empty-materials.json')
  assert.equal(queueItemOptions(reused).materialManifestPath, 'new-empty-materials.json')
  const fromShots = createShotsQueueItem({ shotsJson: 'shots.json', currentRun: null, workflowPlan: ['clip', 'compose'], materialMode: 'download', source: 'pexels', materialSourceMode: 'pexels-only', materialManifestPath: 'new-empty-materials.json' })
  assert.equal(fromShots.materialManifestPath, 'new-empty-materials.json')
  assert.equal(queueItemOptions({ ...reused, downloadNewMaterials: false }).downloadNewMaterials, true)
})

test('old preferences migrate to source modes while explicit task modes take precedence', () => {
  assert.equal(normalizeMaterialSourceMode(undefined, false), 'pexels-only')
  assert.equal(normalizeMaterialSourceMode(undefined, true), 'library-first')
  assert.equal(normalizeMaterialSourceMode('invalid'), 'library-first')
  assert.equal(normalizeMaterialSourceMode('library-only', false), 'library-only')
  const legacy = { mode: 'plan', preferLocalMaterials: false, downloadNewMaterials: true }
  const continued = prepareQueueItemForGeneration(legacy, { materialMode: 'library', source: '', workflowPlan: ['clip', 'compose'] })
  assert.equal(continued.materialSourceMode, 'pexels-only')
  assert.equal(continued.downloadNewMaterials, true)
  assert.equal(queueItemOptions({ ...continued, materialSourceMode: 'library-only' }).downloadNewMaterials, false)
  const allMatched = createShotsQueueItem({ shotsJson: 'shots.json', currentRun: null, workflowPlan: ['clip', 'compose'], materialMode: 'library', source: 'pexels', materialSourceMode: 'library-first' })
  assert.equal(allMatched.downloadNewMaterials, false)
})
test('restored interrupted generation enables checkpoint retry outside the queue', () => {
  const view = buildStartTaskViewModel({ scriptCount: 0, logs: [], running: false,
    selectedQueueItem: null, taskStage: 'generate',
    shotPlan: { currentRun: { id: 'run', path: 'C:/run', shotsPath: 'C:/run/shots.json' }, shots: [{ shot_id: '1' }], planRoot: {}, planOrigin: 'current', dirty: false },
    workflowProgress: { status: 'failed', phase: 'interrupted' },
  })
  assert.equal(view.canGenerate, true)
  assert.equal(view.generateButtonText, '从失败步骤继续')
})
test('each script retains its canvas through persistence and continued generation', () => {
  const items = createScriptQueueItems({ paths: ['a.xlsx', 'b.xlsx'], mode: 'plan', materialMode: 'download', source: 'pexels', aspectRatio: '9:16' })
  for (const item of JSON.parse(JSON.stringify(items))) {
    const continued = prepareQueueItemForGeneration(item, { shotsJson: 'shots.json', workflowPlan: ['query', 'compose'], materialMode: 'download', source: 'pexels' })
    assert.equal(queueItemOptions(continued).aspectRatio, '9:16')
  }
  assert.equal(createScriptQueueItems({ paths: ['c.xlsx'], mode: 'generate', materialMode: 'download', source: 'pexels' })[0].aspectRatio, '16:9')
})

test('output resolution choices match requested canvases and survive queue persistence and history restore', () => {
  assert.deepEqual(outputResolutions('16:9'), ['720p', '1080p', '4k'])
  assert.deepEqual(outputResolutions('9:16'), ['1080p', '4k'])
  assert.deepEqual(outputResolutions('4:3'), ['1080p'])
  assert.deepEqual(outputResolutions('3:4'), ['1080p'])
  assert.equal(normalizeOutputResolution('9:16', '720p'), '1080p')
  for (const [aspectRatio, outputResolution, label] of [
    ['16:9', '720p', '1280 × 720'], ['16:9', '4k', '3840 × 2160'], ['9:16', '4k', '2160 × 3840'],
  ]) {
    assert.equal(outputSizeLabel(aspectRatio, outputResolution), label)
    const [item] = createScriptQueueItems({ paths: ['script.xlsx'], mode: 'plan', materialMode: 'download', source: 'pexels', aspectRatio, outputResolution })
    const continued = prepareQueueItemForGeneration(JSON.parse(JSON.stringify(item)), { shotsJson: 'shots.json', workflowPlan: ['query', 'compose'], materialMode: 'download', source: 'pexels' })
    assert.equal(queueItemOptions(continued).outputResolution, outputResolution)
    const restored = createShotsQueueItem({ shotsJson: 'run/shots.json', currentRun: { outputFormat: { aspectRatio, outputResolution } }, workflowPlan: ['query', 'compose'], materialMode: 'download', source: 'pexels' })
    assert.equal(queueItemOptions(restored).aspectRatio, aspectRatio)
    assert.equal(queueItemOptions(restored).outputResolution, outputResolution)
  }
})
import {
  materialVideoPreviewUrl,
  createFolderMaterialSelection,
  applyMaterialSelectionSummary,
  materialBindingsToSelections,
  localMaterialListing,
  selectionsToMaterialBindings,
  summarizeShotMaterialSelections,
} from '../src/pages/start/shotMaterialSelectionModel.ts'
import {
  resetAutomaticMaterialResolution,
  normalizeShots,
  shotsWithoutMaterialSelection,
} from '../src/pages/start/shotPlan.ts'
import {
  applyScriptMaterialScope,
  retainScriptMaterialSelections,
  scriptMaterialBindingsByPath,
  scriptMaterialKey,
} from '../src/pages/start/scriptMaterialScope.ts'

test('scripts with identical names keep independent frozen material scopes', () => {
  const paths = ['C:\\Project A\\script.xlsx', 'C:\\Project B\\script.xlsx', 'C:\\Project C\\script.xlsx']
  const selections = {
    [scriptMaterialKey(paths[0])]: [{ id: 'mat_a', kind: 'file', name: 'A' }],
    [scriptMaterialKey(paths[1])]: [{ id: 'fld_b', kind: 'folder', name: 'B', includeSubfolders: true }],
  }
  const scopes = scriptMaterialBindingsByPath(selections)
  const items = createScriptQueueItems({ paths, mode: 'plan', materialMode: 'download', source: 'pexels', scriptMaterialBindings: scopes })
  assert.deepEqual(items[0].scriptMaterialBindings, [{ binding_type: 'material', material_id: 'mat_a' }])
  assert.deepEqual(items[1].scriptMaterialBindings, [{ binding_type: 'folder', folder_id: 'fld_b', include_subfolders: true }])
  assert.deepEqual(items[2].scriptMaterialBindings, [])
  scopes[scriptMaterialKey(paths[0])][0].material_id = 'mat_changed'
  assert.equal(items[0].scriptMaterialBindings[0].material_id, 'mat_a')
  assert.equal(scriptMaterialKey(paths[0]), scriptMaterialKey('c:/project a/script.xlsx'))
  assert.deepEqual(Object.keys(retainScriptMaterialSelections(selections, [paths[1]])), [scriptMaterialKey(paths[1])])
  assert.deepEqual(retainScriptMaterialSelections(selections, []), {})
  const continued = prepareQueueItemForGeneration(items[0], { materialMode: 'library', source: '', workflowPlan: ['clip', 'compose'] })
  assert.deepEqual(continued.scriptMaterialBindings, items[0].scriptMaterialBindings)
})

test('script scopes bind automatic shots once and preserve later storyboard edits', () => {
  const bindings = [{ binding_type: 'folder', folder_id: 'fld_script', include_subfolders: true }]
  const root = { topic: 'Test', shots: [
    { shot_id: 'new', download_material: true },
    { shot_id: 'old_auto', download_material: false, material_bindings: [{ binding_type: 'material', material_id: 'mat_old' }], material_resolution: { strategy: 'library' } },
    { shot_id: 'manual', download_material: false, material_bindings: [{ binding_type: 'material', material_id: 'mat_manual' }] },
  ] }
  const scoped = applyScriptMaterialScope(root, bindings)
  assert.equal(scoped.script_material_scope_applied, true)
  assert.equal(scoped.shots.every((shot) => !shot.download_material), true)
  assert.deepEqual(scoped.shots[0].material_bindings, bindings)
  assert.deepEqual(scoped.shots[1].material_bindings, bindings)
  assert.equal(scoped.shots[1].material_resolution, undefined)
  assert.equal(scoped.shots[2].material_bindings[0].material_id, 'mat_manual')
  assert.equal(root.shots[0].download_material, true)
  scoped.shots[0].material_bindings[0].folder_id = 'fld_edited'
  assert.equal(scoped.shots[1].material_bindings[0].folder_id, 'fld_script')
  assert.equal(bindings[0].folder_id, 'fld_script')
  assert.equal(applyScriptMaterialScope(scoped, bindings), scoped)
  assert.equal(applyScriptMaterialScope(root), root)
  const emptyRoot = { shots: [] }
  assert.equal(applyScriptMaterialScope(emptyRoot, bindings), emptyRoot)
  const toggled = resetAutomaticMaterialResolution(scoped.shots)
  assert.deepEqual(toggled, scoped.shots)
})

test('local script picker excludes cloud-only, missing, damaged and unregistered materials', () => {
  const listing = {
    current: { id: 'root', kind: null, name: '素材库' }, breadcrumbs: [],
    folders: [{ id: 'local', kind: 'user' }, { id: 'cloud', kind: 'cloud' }],
    files: [
      { materialId: 'mat_local', localStatus: 'present', path: 'C:/local.mp4' },
      { materialId: 'mat_synced', localStatus: 'present', cloudStatus: 'ready', path: 'C:/synced.mp4' },
      { materialId: 'mat_cloud', localStatus: 'missing', cloudStatus: 'ready' },
      { materialId: 'mat_damaged', localStatus: 'damaged', path: 'C:/bad.mp4' },
      { localStatus: 'present', path: 'C:/unregistered.mp4' },
    ],
  }
  const local = localMaterialListing(listing)
  assert.deepEqual(local.folders.map((folder) => folder.id), ['local'])
  assert.deepEqual(local.files.map((file) => file.materialId), ['mat_local', 'mat_synced'])
  assert.equal(listing.files.length, 5)
})

test('workflow protocol normalization rejects unsupported values and keeps numeric zeroes', () => {
  assert.deepEqual(
    normalizeWorkflowPlan({ stages: ['script', 'query', 'card', 'query', 'done', 'unknown', 'clip'] }),
    ['script', 'query', 'clip'],
  )
  assert.deepEqual(normalizeWorkflowProgress({
    stage: 'material',
    status: 'running',
    phase: ' downloading ',
    current: 0,
    total: '12',
  }), {
    stage: 'material',
    status: 'running',
    phase: 'downloading',
    current: 0,
    total: 12,
  })
  assert.equal(normalizeWorkflowProgress({ stage: 'unknown', status: 'unknown' }), undefined)
})

test('generation preflight reports only manual shots without a selected material range', () => {
  const shots = normalizeShots([
    { shot_id: 'shot_missing', title: '缺少素材', download_material: false },
    { shot_id: 'shot_folder', title: '文件夹素材', download_material: false, material_bindings: [
      { binding_type: 'folder', folder_id: 'fld_products', include_subfolders: true },
    ] },
    { shot_id: 'shot_download', title: '自动下载', download_material: true },
  ])

  assert.deepEqual(shotsWithoutMaterialSelection(shots), [{
    index: 0,
    shotId: 'shot_missing',
    title: '缺少素材',
  }])
})

test('local priority toggle clears automatic results but preserves explicit manual choices', () => {
  const shots = normalizeShots([
    { shot_id: 'manual', download_material: false, material_bindings: [
      { binding_type: 'material', material_id: 'mat_manual' },
    ] },
    { shot_id: 'auto_bound', download_material: false, material_bindings: [
      { binding_type: 'material', material_id: 'mat_auto' },
    ], material_resolution: { strategy: 'library' } },
    { shot_id: 'legacy_empty', download_material: false, material_bindings: [] },
    { shot_id: 'auto', download_material: true },
  ])
  const reset = resetAutomaticMaterialResolution(shots)
  assert.equal(reset[0], shots[0])
  assert.equal(reset.slice(1).every((shot) => shot.download_material), true)
  assert.equal(reset.slice(1).every((shot) => !shot.material_bindings.length), true)
  assert.equal(reset[1].material_resolution, undefined)
  assert.equal(shots[1].download_material, false)
  assert.deepEqual(shotsWithoutMaterialSelection(reset), [])
})

test('queue snapshots local priority and keeps direct-download continuation enabled', () => {
  const [direct] = createScriptQueueItems({
    paths: ['test.xlsx'], mode: 'plan', materialMode: 'download', source: '',
    preferLocalMaterials: false, autoContinueToGenerate: true,
  })
  assert.equal(direct.preferLocalMaterials, false)
  assert.equal(direct.autoContinueToGenerate, true)
  assert.equal(direct.source, 'pexels')
  assert.equal(direct.downloadNewMaterials, true)
  const continued = prepareQueueItemForGeneration(direct, {
    materialMode: 'download', source: '', workflowPlan: ['material', 'clip', 'compose'],
  })
  assert.equal(continued.preferLocalMaterials, false)
  assert.equal(queueItemOptions(continued).source, 'pexels')
  assert.equal(queueItemOptions(continued).downloadNewMaterials, true)
  const [next] = createScriptQueueItems({
    paths: ['next.xlsx'], mode: 'plan', materialMode: 'download', source: 'pexels',
    preferLocalMaterials: true,
  })
  assert.equal(next.preferLocalMaterials, true)
  assert.equal(direct.preferLocalMaterials, false)
})

test('automatic continuation remains busy between planning and generation', () => {
  const [item] = createScriptQueueItems({
    paths: ['test.xlsx'], mode: 'plan', materialMode: 'download', source: 'pexels',
    preferLocalMaterials: false, autoContinueToGenerate: true,
  })
  assert.equal(isAutomaticallyPreparingQueueItem(item), false)
  assert.equal(isAutomaticallyPreparingQueueItem({ ...item, status: 'running' }), false)
  assert.equal(isAutomaticallyPreparingQueueItem({ ...item, status: 'done' }), true)
  assert.equal(isAutomaticallyPreparingQueueItem({ ...item, status: 'failed' }), false)
  assert.equal(isAutomaticallyPreparingQueueItem({ ...item, status: 'done', autoContinueToGenerate: false }), false)
  assert.equal(isAutomaticallyPreparingQueueItem({ ...item, status: 'done', mode: 'generate' }), false)
})

test('unresolved material scopes never present recursive catalogue totals as selected candidate counts', () => {
  assert.deepEqual(summarizeShotMaterialSelections([
    { id: 'file-1', kind: 'file', name: '产品展示.mp4' },
    { id: 'folder-1', kind: 'folder', name: '产品素材', videoCount: 12 },
    { id: 'folder-2', kind: 'folder', name: '园区素材', videoCount: 18, includeSubfolders: true },
  ]), {
    candidateCount: null,
    fileCount: 1,
    folderCount: 2,
  })
})

test('new folder selections include descendants, while restored explicit false and legacy missing flags keep their scope', () => {
  const folder = { id: 'fld_scara', name: 'scara', kind: 'user', videoCount: 21 }
  assert.deepEqual(selectionsToMaterialBindings([createFolderMaterialSelection(folder)]), [
    { binding_type: 'folder', folder_id: 'fld_scara', include_subfolders: true },
  ])
  for (const include_subfolders of [false, undefined]) {
    const restored = materialBindingsToSelections([{ binding_type: 'folder', folder_id: folder.id, include_subfolders }])
    assert.equal(selectionsToMaterialBindings(restored)[0].include_subfolders, false)
    assert.equal(summarizeShotMaterialSelections(restored).candidateCount, null)
  }
  assert.equal(selectionsToMaterialBindings([createFolderMaterialSelection({
    ...folder, id: 'folder-local-view', bindingFolderId: 'fld_real',
  })])[0].folder_id, 'fld_real')
})

test('selected counts deduplicate overlapping scopes and invalidate immediately when recursion changes', () => {
  const allKeys = Array.from({ length: 21 }, (_, index) => `asset:asset_${index}:1`)
  const selections = [
    createFolderMaterialSelection({ id: 'fld_scara', name: 'scara', kind: 'user', videoCount: 21 }),
    createFolderMaterialSelection({ id: 'fld_child', name: 'SCR应用', kind: 'user', videoCount: 14 }),
    { id: 'mat_one', kind: 'file', name: '机器人.mp4' },
  ]
  const resolved = applyMaterialSelectionSummary(selections, { candidateCount: 21, entries: [
    { key: 'folder:fld_scara', candidateKeys: allKeys },
    { key: 'folder:fld_child', candidateKeys: allKeys.slice(0, 14) },
    { key: 'material:mat_one', candidateKeys: [allKeys[0]] },
  ] })
  assert.deepEqual(summarizeShotMaterialSelections(resolved), { candidateCount: 21, fileCount: 1, folderCount: 2 })
  const currentOnly = { ...resolved[0], includeSubfolders: false }
  assert.equal(summarizeShotMaterialSelections([currentOnly]).candidateCount, null)
  const empty = applyMaterialSelectionSummary([currentOnly], { candidateCount: 0, entries: [
    { key: 'folder:fld_scara', candidateKeys: [] },
  ] })
  assert.equal(summarizeShotMaterialSelections(empty).candidateCount, 0)
  assert.equal(selectionsToMaterialBindings(empty)[0].include_subfolders, false)
  assert.equal(selections[0].candidateKeys, undefined)
  assert.throws(() => applyMaterialSelectionSummary(selections, { candidateCount: 0, entries: [] }), /未完成统计/)
})

test('material picker uses locally available video as its first-frame preview source', () => {
  const localVideo = {
    name: 'local.mp4',
    path: 'C:\\materials\\local.mp4',
    url: 'videoauto-media://file/local-token',
    size: 12,
    mtime: 1,
    ext: '.mp4',
    localStatus: 'present',
  }
  assert.equal(materialVideoPreviewUrl(localVideo), localVideo.url)
  assert.equal(materialVideoPreviewUrl({ ...localVideo, localStatus: 'missing' }), '')
  assert.equal(materialVideoPreviewUrl({ ...localVideo, localStatus: 'damaged' }), '')
  assert.equal(materialVideoPreviewUrl({ ...localVideo, url: '' }), '')
})

test('shot plans persist stable ids and only minimal material bindings', () => {
  const [shot] = normalizeShots([{
    shot: 1,
    title: '开场',
    download_material: false,
    material_bindings: [
      { binding_type: 'material', material_id: 'mat_1', local_path: 'C:\\private.mp4' },
      { binding_type: 'folder', folder_id: 'fld_1', include_subfolders: true, path: 'C:\\private' },
    ],
  }])
  assert.match(shot.shot_id, /^shot_/)
  assert.equal(shot.download_material, false)
  assert.deepEqual(shot.material_bindings, [
    { binding_type: 'material', material_id: 'mat_1' },
    { binding_type: 'folder', folder_id: 'fld_1', include_subfolders: true },
  ])

  const bindings = selectionsToMaterialBindings([
    {
      id: 'mat_2',
      kind: 'file',
      name: '素材.mp4',
      file: {
        name: '素材.mp4',
        path: 'C:\\managed\\素材.mp4',
        url: 'file:///managed/video.mp4',
        size: 12,
        mtime: 1,
        ext: '.mp4',
        materialId: 'mat_2',
      },
    },
    { id: 'fld_2', kind: 'folder', name: '素材文件夹', includeSubfolders: false },
  ])
  assert.deepEqual(bindings, [
    { binding_type: 'material', material_id: 'mat_2' },
    { binding_type: 'folder', folder_id: 'fld_2', include_subfolders: false },
  ])
  assert.equal(JSON.stringify(bindings).includes('path'), false)

  assert.throws(() => normalizeShots([{
    shot_id: 'shot_conflict',
    download_material: true,
    material_bindings: [{ binding_type: 'material', material_id: 'mat_1' }],
  }]), /不能保留素材绑定/)
})

test('preview refresh predicates recognize protocol stages and artifact messages', () => {
  assert.equal(shouldRefreshPlanPreview({ text: '已写入 shots.json' }), true)
  assert.equal(shouldRefreshPlanPreview({ text: '普通日志' }), false)
  assert.equal(shouldRefreshMaterialPreview({ workflowStage: 'clip' }), true)
  assert.equal(shouldRefreshMaterialPreview({ text: 'final_clips 已更新' }), true)
  assert.equal(shouldRefreshMaterialPreview({ text: '普通日志', workflowStage: 'voice' }), false)
})

test('workflow inference adds optional voice and BGM stages but omits card content', () => {
  const plan = inferWorkflowPlanFromShots([{
    voice_text: '旁白',
    card_hint: '标题卡',
  }], {
    background_music: { enabled: true },
  })

  assert.deepEqual(plan, ['script', 'plan', 'query', 'material', 'voice', 'clip', 'compose', 'bgm'])
  assert.equal(inferWorkflowPlanFromShots([], { extra_requirements: '不要背景音乐' }).includes('bgm'), false)
  assert.equal(inferTaskStageFromCommand('engine --plan-only'), 'plan')
  assert.equal(inferTaskStageFromCommand('engine --shots-json plan.json'), 'generate')
})

test('workflow rendering hides card stages from legacy plans and compose copy', () => {
  const workflow = buildTaskWorkflow({
    running: true,
    taskStage: 'generate',
    materialMode: 'download',
    hasVisiblePlan: true,
    dirty: false,
    workflowStage: 'card',
    workflowPlan: ['script', 'plan', 'query', 'material', 'card', 'clip', 'compose'],
    workflowProgress: { stage: 'card', status: 'running' },
    hasVoiceContent: false,
    hasProgressBarContent: true,
    shotCount: 1,
    candidateCount: 1,
    clipCount: 0,
  })

  assert.deepEqual(workflow.steps.map(({ id }) => id), ['script', 'plan', 'query', 'material', 'clip', 'compose'])
  assert.equal(workflow.steps.find(({ id }) => id === 'compose')?.detail.includes('卡片'), false)
})

test('plan-only workflow keeps the upcoming generation stages visible', () => {
  const workflow = buildTaskWorkflow({
    running: true,
    taskStage: 'plan',
    materialMode: 'download',
    hasVisiblePlan: false,
    dirty: false,
    workflowStage: 'script',
    workflowPlan: ['script', 'plan'],
    workflowProgress: { stage: 'script', status: 'running' },
    hasVoiceContent: false,
    hasProgressBarContent: false,
    shotCount: 0,
    candidateCount: 0,
    clipCount: 0,
  })

  assert.deepEqual(
    workflow.steps.map(({ id }) => id),
    ['script', 'plan', 'query', 'material', 'clip', 'compose'],
  )
  assert.equal(workflow.steps.find(({ id }) => id === 'query')?.status, 'pending')
})

test('a completed plan is never presented as a generated final video', () => {
  const workflow = buildTaskWorkflow({
    running: false,
    taskStage: 'plan',
    materialMode: 'download',
    hasVisiblePlan: true,
    dirty: false,
    currentRun: { shotsPath: 'C:\\run\\shots.json', finalVideo: '' },
    workflowStage: 'done',
    workflowPlan: ['script', 'plan'],
    workflowProgress: { stage: 'plan', status: 'completed' },
    hasVoiceContent: false,
    hasProgressBarContent: false,
    shotCount: 8,
    candidateCount: 0,
    clipCount: 0,
  })

  assert.equal(workflow.summary, '分镜方案已就绪，下一步生成视频')
  assert.equal(workflow.progress < 100, true)
  assert.equal(workflow.steps.find(({ id }) => id === 'compose')?.status, 'pending')
})

test('script path and queue adapters normalize boundary data without mutating it', () => {
  assert.deepEqual(
    normalizeScriptPaths(' "C:\\a.md"\nC:\\b.md\nC:\\a.md\n'),
    ['C:\\a.md', 'C:\\b.md'],
  )
  assert.equal(samePathList(['a', 'b'], ['a', 'b']), true)
  assert.equal(samePathList(['a', 'b'], ['b', 'a']), false)

  const item = {
    mode: 'plan',
    status: 'running',
    scriptPath: 'C:\\a.md',
    source: 'pexels',
    downloadNewMaterials: true,
    pid: 42,
    command: 'engine --plan-only',
  }
  assert.deepEqual(queueItemOptions(item), {
    materialSourceMode: 'library-first',
    scriptPath: 'C:\\a.md',
    projectName: undefined,
    shotsJson: undefined,
    source: 'pexels',
    downloadNewMaterials: true,
    planOnly: true,
  })
  assert.deepEqual(queueItemToTask(item), {
    pid: 42,
    command: 'engine --plan-only',
    code: undefined,
    runId: undefined,
    runPath: undefined,
    startedAt: undefined,
    status: 'running',
  })
  assert.equal(taskFromStatus({ running: false }), null)
})

test('queue factories centralize path labels, material options and task reset fields', () => {
  assert.equal(basename('C:\\scripts\\demo.md'), 'demo.md')
  assert.equal(basename('/tmp/demo.md'), 'demo.md')
  assert.equal(basename('', '未命名'), '未命名')

  const scripts = createScriptQueueItems({
    paths: ['C:\\scripts\\a.md', '/tmp/b.md'],
    mode: 'plan',
    materialMode: 'library',
    source: 'ignored',
    createdAt: '2026-01-01T00:00:00.000Z',
    createId: (index) => `task-${index}`,
  })
  assert.deepEqual(scripts.map(({ id, title, projectName, source, downloadNewMaterials, workflowPlan }) => ({
    id,
    title,
    projectName,
    source,
    downloadNewMaterials,
    workflowPlan,
  })), [
    { id: 'task-0', title: 'a.md', projectName: 'a', source: undefined, downloadNewMaterials: false, workflowPlan: ['script', 'plan'] },
    { id: 'task-1', title: 'b.md', projectName: 'b', source: undefined, downloadNewMaterials: false, workflowPlan: ['script', 'plan'] },
  ])

  const automatic = createScriptQueueItems({
    paths: ['C:\\scripts\\auto.md'],
    mode: 'plan',
    materialMode: 'download',
    source: 'pexels',
    autoContinueToGenerate: true,
    createId: () => 'auto-task',
  })[0]
  assert.equal(automatic.autoContinueToGenerate, true)
  assert.equal(automatic.mode, 'plan')

  const reused = prepareQueueItemForGeneration({
    ...scripts[0],
    status: 'failed',
    pid: 42,
    command: 'old command',
    finishedAt: 'old timestamp',
  }, {
    shotsJson: 'C:\\run\\shots.json',
    workflowPlan: ['script', 'plan', 'query', 'material', 'clip', 'compose'],
    materialMode: 'download',
    source: 'pexels',
  })
  assert.equal(reused.status, 'queued')
  assert.equal(reused.pid, undefined)
  assert.equal(reused.command, undefined)
  assert.equal(reused.finishedAt, undefined)
  assert.equal(reused.source, 'pexels')
  assert.equal(reused.downloadNewMaterials, true)

  const shotsItem = createShotsQueueItem({
    shotsJson: 'C:\\run\\shots.json',
    currentRun: { id: 'run-7', projectName: '上下料B端视频' },
    workflowPlan: ['script', 'plan', 'query', 'material', 'clip', 'compose'],
    materialMode: 'library',
    source: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    createId: () => 'shots-task',
  })
  assert.equal(shotsItem.title, '上下料B端视频 生成视频')
  assert.equal(shotsItem.projectName, '上下料B端视频')
  assert.equal(findQueueItemForPlan(
    [shotsItem, { ...shotsItem, id: 'selected', runId: 'run-7' }],
    'selected',
    shotsItem.shotsJson,
    { id: 'run-7' },
  )?.id, 'selected')
})

test('start task view model derives completed and selected queue states consistently', () => {
  const completed = buildStartTaskViewModel({
    scriptCount: 0,
    logs: ['global'],
    running: false,
    selectedQueueItem: null,
    shotPlan: {
      currentRun: { shotsPath: 'C:\\run\\shots.json', finalVideo: 'C:\\run\\final.mp4' },
      shots: [{}],
      dirty: false,
      planOrigin: 'current',
    },
    taskStage: 'idle',
  })
  assert.equal(completed.generateButtonText, '视频已生成')
  assert.equal(completed.canGenerate, false)
  assert.equal(completed.taskStatusLabel, '当前方案')

  const failedAfterCompose = buildStartTaskViewModel({
    scriptCount: 0,
    logs: ['global'],
    running: false,
    selectedQueueItem: {
      mode: 'generate',
      status: 'failed',
      workflowStage: 'bgm',
      logs: ['BGM 搜索超时'],
    },
    shotPlan: {
      currentRun: { shotsPath: 'C:\\run\\shots.json', finalVideo: 'C:\\run\\final.mp4' },
      shots: [{}],
      dirty: false,
      planOrigin: 'current',
    },
    taskStage: 'idle',
  })
  assert.equal(failedAfterCompose.generateButtonText, '从失败步骤继续')
  assert.equal(failedAfterCompose.canGenerate, true)
  assert.equal(failedAfterCompose.taskStatusLabel, '背景音乐失败')

  const failedAfterComposeWithoutQueue = buildStartTaskViewModel({
    scriptCount: 0,
    logs: ['BGM 搜索超时'],
    running: false,
    selectedQueueItem: null,
    shotPlan: {
      currentRun: { shotsPath: 'C:\\run\\shots.json', finalVideo: 'C:\\run\\final.mp4' },
      shots: [{}],
      dirty: false,
      planOrigin: 'current',
    },
    taskStage: 'idle',
    workflowStage: 'bgm',
    workflowProgress: {
      stage: 'bgm',
      status: 'failed',
      phase: 'unavailable',
      label: '未找到可用背景音乐，已保留原成片',
    },
  })
  assert.equal(failedAfterComposeWithoutQueue.generateButtonText, '从失败步骤继续')
  assert.equal(failedAfterComposeWithoutQueue.canGenerate, true)
  assert.equal(failedAfterComposeWithoutQueue.taskStatusLabel, '背景音乐失败')
  assert.equal(failedAfterComposeWithoutQueue.viewWorkflowFailed, true)

  const cancelledWithoutQueue = buildStartTaskViewModel({
    scriptCount: 0,
    logs: ['stopped'],
    running: false,
    selectedQueueItem: null,
    shotPlan: {
      currentRun: { shotsPath: 'C:\\run\\shots.json', finalVideo: 'C:\\run\\final.mp4' },
      shots: [{}],
      dirty: false,
      planOrigin: 'current',
    },
    taskStage: 'idle',
    workflowStage: 'bgm',
    workflowProgress: { stage: 'bgm', status: 'failed', phase: 'cancelled', label: '任务已停止' },
  })
  assert.equal(cancelledWithoutQueue.taskStatusLabel, '已停止')
  assert.equal(cancelledWithoutQueue.canGenerate, true)

  const selectedPlan = buildStartTaskViewModel({
    scriptCount: 1,
    logs: ['global'],
    running: true,
    selectedQueueItem: {
      mode: 'plan',
      status: 'done',
      previewReady: true,
      logs: ['selected'],
    },
    shotPlan: { shots: [], dirty: false, planOrigin: 'none' },
    taskStage: 'generate',
  })
  assert.equal(selectedPlan.taskStatusLabel, '分镜已就绪')
  assert.equal(selectedPlan.viewRunning, false)
  assert.deepEqual(selectedPlan.viewLogs, ['selected'])

  const runningGeneration = buildStartTaskViewModel({
    scriptCount: 0,
    logs: ['global'],
    running: true,
    selectedQueueItem: {
      mode: 'generate',
      status: 'running',
      logs: ['正在匹配素材'],
    },
    shotPlan: {
      currentRun: { shotsPath: 'C:\\run\\shots.json' },
      shots: [{}],
      dirty: false,
      planOrigin: 'current',
    },
    taskStage: 'generate',
  })
  assert.equal(runningGeneration.generateButtonText, '生成视频中')
  assert.equal(runningGeneration.canGenerate, false)
  assert.equal(runningGeneration.viewRunning, true)

  const runningPlan = buildStartTaskViewModel({
    scriptCount: 1,
    logs: ['正在整理'],
    running: true,
    selectedQueueItem: null,
    shotPlan: { shots: [], dirty: false, planOrigin: 'none' },
    taskStage: 'plan',
  })
  assert.equal(runningPlan.generateButtonText, '正在整理分镜')
  assert.equal(runningPlan.canGenerate, false)
})

test('BGM failure remains visible after the base video has been composed', () => {
  const workflow = buildTaskWorkflow({
    running: false,
    taskStage: 'generate',
    materialMode: 'download',
    hasVisiblePlan: true,
    dirty: false,
    currentRun: { finalVideo: 'C:\\run\\final.mp4' },
    workflowStage: 'bgm',
    workflowPlan: ['script', 'plan', 'query', 'material', 'clip', 'compose', 'bgm'],
    workflowProgress: {
      stage: 'bgm',
      status: 'failed',
      phase: 'failed',
      label: '背景音乐处理失败，已保留原成片',
    },
    workflowFailed: true,
    hasVoiceContent: false,
    hasProgressBarContent: false,
    shotCount: 1,
    candidateCount: 1,
    clipCount: 1,
  })

  assert.equal(workflow.steps.at(-1)?.id, 'bgm')
  assert.equal(workflow.steps.at(-1)?.status, 'failed')
  assert.equal(workflow.steps.at(-1)?.meta, '背景音乐处理失败，已保留原成片')
  assert.equal(workflow.summary, '背景音乐失败')
})

test('a user-paused workflow is not described as a synthesis failure', () => {
  const workflow = buildTaskWorkflow({ running: false, taskStage: 'generate', materialMode: 'library',
    hasVisiblePlan: true, dirty: false, workflowStage: 'voice', workflowFailed: true,
    workflowPlan: ['script', 'plan', 'voice', 'clip', 'compose'],
    workflowProgress: { stage: 'voice', status: 'failed', phase: 'cancelled', label: '任务已停止' },
    hasVoiceContent: true, hasProgressBarContent: false, shotCount: 1, candidateCount: 1, clipCount: 0 });
  assert.equal(workflow.summary, '任务已暂停，可编辑后继续');
  assert.equal(workflow.progress < 100, true);
});
