import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const desktop = path.resolve(process.argv[2])
const handlers = new Map()
globalThis.__videoAutoCutElectronMock = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return {
      shortCircuit: true,
      url: 'data:text/javascript,export const ipcMain=globalThis.__videoAutoCutElectronMock.ipcMain',
    }
    return nextResolve(specifier, context)
  },
})
const { registerIpcHandlers } = await import(pathToFileURL(path.join(desktop, 'dist-electron', 'ipc-handlers.js')))
const { createWorkspaceService } = await import(pathToFileURL(path.join(desktop, 'dist-electron', 'workspace-service.js')))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-script-reveal-baseline-'))
try {
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(dataRoot, { recursive: true })
  const script = path.join(root, 'frozen.xlsx')
  fs.writeFileSync(script, 'baseline', 'utf8')
  const service = (overrides = {}) => new Proxy(overrides, {
    get(target, property) { return property in target ? target[property] : () => ({}) },
  })
  const workspaceService = createWorkspaceService({
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
  registerIpcHandlers({
    accountService: service(),
    appUpdateService: service(),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    getAppInfo: () => ({}),
    getMainWindow: () => null,
    materialLocalStore: service(),
    materialCloudService: service(),
    materialsService: service(),
    runtimeService: service(),
    setWindowMode: () => true,
    shell: { openPath: async () => '', showItemInFolder: () => assert.fail('old route cannot reveal'), trashItem: async () => {} },
    taskService: { start: async () => ({ ok: true, pid: 7 }), status: () => ({}), stop: async () => ({ ok: true }) },
    voiceService: service(),
    workspaceService,
  })
  const started = await handlers.get('task:start')({}, { scriptPath: script })
  let folderOpenError = ''
  try {
    await handlers.get('folder:open')({}, path.dirname(script))
  } catch (error) {
    folderOpenError = error instanceof Error ? error.message : String(error)
  }
  const queueSource = fs.readFileSync(path.join(desktop, 'src/pages/start/TaskQueuePopover.tsx'), 'utf8')
  const receipt = {
    sourceHead: '25fcd892e6ada40e2498e28e5aff9b7af26a0f71',
    taskStartOk: started.ok === true,
    scriptRevealRegistered: handlers.has('script:reveal'),
    oldBlockedButtonUsesOpenContainingFolder: queueSource.includes('openContainingFolder'),
    oldBlockedButtonUsesRevealScript: queueSource.includes('revealScript'),
    oldFolderOpenError: folderOpenError,
    oldFolderOpenRejectedExternalScriptParent: folderOpenError.includes('已拒绝删除'),
  }
  console.log(JSON.stringify(receipt, null, 2))
  assert.equal(receipt.taskStartOk, true)
  assert.equal(receipt.oldBlockedButtonUsesOpenContainingFolder, true)
  assert.equal(receipt.oldFolderOpenRejectedExternalScriptParent, true)
  assert.equal(receipt.scriptRevealRegistered, true, 'dedicated script:reveal handler is missing on the original HEAD')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}