import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createWorkspaceService } from '../dist-electron/workspace-service.js'

const registeredIpcHandlers = new Map()
globalThis.__videoAutoCutElectronMock = {
  ipcMain: {
    handle: (channel, handler) => registeredIpcHandlers.set(channel, handler),
  },
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const ipcMain=globalThis.__videoAutoCutElectronMock.ipcMain',
      }
    }
    return nextResolve(specifier, context)
  },
})

function service(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property]
      return () => ({})
    },
  })
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-script-reveal-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const script = path.join(root, 'blocked.xlsx')
  const otherScript = path.join(root, 'other.xlsx')
  const nonScript = path.join(root, 'payload.exe')
  const directory = path.join(root, 'directory.xlsx')
  fs.writeFileSync(script, 'script', 'utf8')
  fs.writeFileSync(otherScript, 'other', 'utf8')
  fs.writeFileSync(nonScript, 'not a script', 'utf8')
  fs.mkdirSync(directory)
  return { root, script, otherScript, nonScript, directory }
}

function createWorkspace(root, historicalScripts = []) {
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(dataRoot, { recursive: true })
  const workspace = createWorkspaceService({
    appName: 'VideoAutoCutTest',
    userDataRoot: root,
    configRoot: path.join(root, 'config'),
    dataRoot,
    legacyDataRoot: path.join(root, 'legacy'),
    envPath: path.join(root, 'config', 'app.env'),
    runsDir: path.join(dataRoot, 'runs'),
    defaultOutputDir: path.join(dataRoot, 'output'),
    materialsDir: path.join(dataRoot, 'materials'),
    voiceTemplatesDir: path.join(dataRoot, 'voices'),
    runtimeManifestDefaultUrl: '',
    getVideoAutoRoot: () => root,
  })
  if (!historicalScripts.length) return workspace
  return { ...workspace, listRunScriptPaths: () => historicalScripts }
}

async function registerApplicationIpc({ root, taskStart, shell, historicalScripts = [], scope = 'guest' }) {
  const { registerIpcHandlers } = await import('../dist-electron/ipc-handlers.js')
  registeredIpcHandlers.clear()
  registerIpcHandlers({
    accountService: service(),
    appUpdateService: service(),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getAppInfo: () => ({}),
    getMainWindow: () => null,
    materialLocalStore: service({
      effectiveScope: () => typeof scope === 'function' ? scope() : scope,
      getScopeDatabasePath: (selectedScope = (typeof scope === 'function' ? scope() : scope)) => path.join(root, 'accounts', selectedScope, 'materials.sqlite'),
    }),
    materialCloudService: service(),
    materialsService: service(),
    runtimeService: service(),
    setWindowMode: () => true,
    shell,
    taskService: {
      start: taskStart,
      status: () => ({}),
      stop: async () => ({ ok: true }),
    },
    voiceService: service(),
    workspaceService: createWorkspace(root, historicalScripts),
  })
  return registeredIpcHandlers
}

function testShell(shown) {
  return {
    openPath: async () => '',
    showItemInFolder: (file) => shown.push(file),
    trashItem: async () => {},
  }
}

test('script reveal allows only a successfully started, registered script file', async (t) => {
  const fixture = createFixture(t)
  const shown = []
  const handlers = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: true, pid: 42 }),
    shell: testShell(shown),
  })

  assert.deepEqual(await handlers.get('task:start')({}, { scriptPath: fixture.script }), { ok: true, pid: 42 })
  assert.equal(handlers.get('script:reveal')({}, fixture.script), true)
  assert.deepEqual(shown, [fs.realpathSync.native(fixture.script)])
})

test('script reveal rejects failed starts and other unregistered script files', async (t) => {
  const fixture = createFixture(t)
  const shown = []
  let startResult = { ok: false, message: 'not started' }
  const handlers = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => startResult,
    shell: testShell(shown),
  })

  assert.deepEqual(await handlers.get('task:start')({}, { scriptPath: fixture.script }), startResult)
  assert.throws(() => handlers.get('script:reveal')({}, fixture.script), /未登记/)
  startResult = { ok: true, pid: 43 }
  assert.deepEqual(await handlers.get('task:start')({}, { scriptPath: fixture.script }), startResult)
  assert.throws(() => handlers.get('script:reveal')({}, fixture.otherScript), /未登记/)
  assert.deepEqual(shown, [])
})

test('script reveal rejects relative, missing, directory and non-script targets without changing task start results', async (t) => {
  const fixture = createFixture(t)
  const shown = []
  const startResult = { ok: true, pid: 84 }
  const handlers = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => startResult,
    shell: testShell(shown),
  })
  const missing = path.join(fixture.root, 'missing.xlsx')

  for (const [target, expected] of [
    ['relative.xlsx', /绝对路径/],
    [missing, /不存在/],
    [fixture.directory, /不是文件/],
    [fixture.nonScript, /脚本文件/],
  ]) {
    assert.deepEqual(await handlers.get('task:start')({}, { scriptPath: target }), startResult)
    assert.throws(() => handlers.get('script:reveal')({}, target), expected)
  }
  assert.deepEqual(shown, [])
})

test('script reveal compares canonical file identity and rechecks existence', async (t) => {
  const fixture = createFixture(t)
  const shown = []
  const handlers = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: true }),
    shell: testShell(shown),
  })
  const equivalent = `${path.dirname(fixture.script)}${path.sep}.${path.sep}${path.basename(fixture.script)}`

  await handlers.get('task:start')({}, { scriptPath: equivalent })
  handlers.get('script:reveal')({}, fixture.script)
  assert.deepEqual(shown, [fs.realpathSync.native(fixture.script)])
  fs.unlinkSync(fixture.script)
  assert.throws(() => handlers.get('script:reveal')({}, fixture.script), /不存在/)
})

test('script reveal restores trusted historical run scripts after restart without opening arbitrary files', async (t) => {
  const fixture = createFixture(t)
  const shown = []
  const handlers = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: false }),
    shell: testShell(shown),
    historicalScripts: [fixture.script, fixture.nonScript, path.join(fixture.root, 'missing.xlsx')],
    scope: 'account-history',
  })

  assert.equal(handlers.get('script:reveal')({}, fixture.script), true)
  assert.throws(() => handlers.get('script:reveal')({}, fixture.otherScript), /未登记/)
  assert.deepEqual(shown, [fs.realpathSync.native(fixture.script)])
})

test('restarted IPC reveals a real logged run script and rejects it after history is removed', async (t) => {
  const fixture = createFixture(t)
  const run = path.join(fixture.root, 'data', 'runs', 'legacy-run')
  fs.mkdirSync(run, { recursive: true })
  const log = path.join(run, 'run.log')
  fs.writeFileSync(log, `脚本文档: ${fixture.script}\n`, 'utf8')
  const shown = []
  const handlers = await registerApplicationIpc({
    root: fixture.root, taskStart: async () => ({ ok: false }), shell: testShell(shown),
    scope: 'account-history-real',
  })
  assert.equal(handlers.get('script:reveal')({}, fixture.script), true)
  fs.unlinkSync(log)
  const restarted = await registerApplicationIpc({
    root: fixture.root, taskStart: async () => ({ ok: false }), shell: testShell(shown),
    scope: 'account-history-real',
  })
  assert.throws(() => restarted.get('script:reveal')({}, fixture.script), /未登记/)
  assert.deepEqual(shown, [fs.realpathSync.native(fixture.script)])
})

test('script reveal persists successful starts across registry restarts and isolates accounts', async (t) => {
  const fixture = createFixture(t)
  const shown = []
  const first = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: true }),
    shell: testShell(shown),
    scope: 'account-a',
  })
  await first.get('task:start')({}, { scriptPath: fixture.script })

  const restarted = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: false }),
    shell: testShell(shown),
    scope: 'account-a',
  })
  assert.equal(restarted.get('script:reveal')({}, fixture.script), true)

  const otherAccount = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: false }),
    shell: testShell(shown),
    scope: 'account-b',
  })
  assert.throws(() => otherAccount.get('script:reveal')({}, fixture.script), /未登记/)
})

test('a deferred start never registers into an account selected while it was running', async (t) => {
  const fixture = createFixture(t)
  let release
  let scope = 'account-a'
  const pending = new Promise((resolve) => { release = resolve })
  const handlers = await registerApplicationIpc({
    root: fixture.root, taskStart: () => pending, shell: testShell([]), scope: () => scope,
  })
  const start = handlers.get('task:start')({}, { scriptPath: fixture.script })
  scope = 'account-b'
  release({ ok: true })
  await start
  assert.throws(() => handlers.get('script:reveal')({}, fixture.script), /未登记/)
  scope = 'account-a'
  assert.equal(handlers.get('script:reveal')({}, fixture.script), true)
})

test('legacy run reveal follows the existing shared local history across accounts', async (t) => {
  const fixture = createFixture(t)
  const owner = await registerApplicationIpc({
    root: fixture.root, taskStart: async () => ({ ok: false }), shell: testShell([]),
    historicalScripts: [fixture.script], scope: 'account-a',
  })
  assert.equal(owner.get('script:reveal')({}, fixture.script), true)

  const other = await registerApplicationIpc({
    root: fixture.root, taskStart: async () => ({ ok: false }), shell: testShell([]),
    historicalScripts: [fixture.script], scope: 'account-b',
  })
  assert.equal(other.get('script:reveal')({}, fixture.script), true)
})

test('damaged registry fails closed when no validated local run history exists', async (t) => {
  const fixture = createFixture(t)
  const accounts = path.join(fixture.root, 'accounts')
  fs.mkdirSync(path.join(accounts, 'account-a'), { recursive: true })
  fs.writeFileSync(path.join(accounts, 'account-a', 'script-reveal.json'), '{bad', 'utf8')
  const handlers = await registerApplicationIpc({
    root: fixture.root, taskStart: async () => ({ ok: false }), shell: testShell([]),
    historicalScripts: [], scope: 'account-a',
  })
  assert.throws(() => handlers.get('script:reveal')({}, fixture.script), /未登记/)
})

test('workspace history reads only a bounded regular run log and never crosses a log symlink', (t) => {
  const fixture = createFixture(t)
  const workspace = createWorkspace(fixture.root)
  const run = path.join(fixture.root, 'data', 'runs', 'legacy-run')
  fs.mkdirSync(run, { recursive: true })
  const log = path.join(run, 'run.log')
  fs.writeFileSync(log, `脚本文档:\n${fixture.script}\n`, 'utf8')
  assert.deepEqual(workspace.listRunScriptPaths(), [], 'empty field must not consume the next line')
  fs.writeFileSync(log, `${'x'.repeat(130000)}\n脚本文档: ${fixture.script}\n`, 'utf8')
  assert.deepEqual(workspace.listRunScriptPaths(), [], 'script path beyond the 120 KB bound is ignored')
  fs.writeFileSync(log, `脚本文档: ${fixture.script}\n`, 'utf8')
  assert.deepEqual(workspace.listRunScriptPaths(), [fixture.script])

  const externalLog = path.join(fixture.root, 'external-log-directory')
  fs.mkdirSync(externalLog)
  fs.unlinkSync(log)
  fs.symlinkSync(externalLog, log, 'junction')
  assert.deepEqual(workspace.listRunScriptPaths(), [])
})

test('registered folder open and file delete IPC handlers reject workspace-external paths', async (t) => {
  const fixture = createFixture(t)
  const externalFile = path.join(fixture.root, 'outside.mp4')
  fs.writeFileSync(externalFile, 'outside', 'utf8')
  const handlers = await registerApplicationIpc({
    root: fixture.root,
    taskStart: async () => ({ ok: false }),
    shell: {
      ...testShell([]),
      openPath: async () => assert.fail('workspace guard must reject before shell.openPath'),
    },
  })

  await assert.rejects(handlers.get('folder:open')({}, fixture.root), /已拒绝删除/)
  assert.deepEqual(handlers.get('file:delete')({}, externalFile), {
    ok: false,
    message: '文件不在工作区内，已拒绝删除',
    removedFile: false,
  })
  assert.equal(fs.existsSync(externalFile), true)
})

test('blocked task queue uses the dedicated reveal API without changing other containing-folder callers', () => {
  const queue = fs.readFileSync(new URL('../src/pages/start/TaskQueuePopover.tsx', import.meta.url), 'utf8')
  const fileActions = fs.readFileSync(new URL('../src/components/common/fileActions.ts', import.meta.url), 'utf8')

  assert.match(queue, /revealScript/)
  assert.doesNotMatch(queue, /openContainingFolder/)
  assert.match(fileActions, /openContainingFolder/)
})
