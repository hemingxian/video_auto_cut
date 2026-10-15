// Run with Electron, not Node. Uses the actual preload/contextBridge and production renderer.
// Business IPC responses are fixtures; no user profile, real credentials, network or visible window.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(process.env.VACUT_SMOKE_APP_ROOT || path.join(__dirname, '..'))
const output = path.resolve(process.env.VACUT_SMOKE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-startup-smoke-')))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
const expectBroken = process.env.VACUT_SMOKE_EXPECT_BROKEN === '1'
const report = { appRoot, hidden: true, realContextBridge: true, businessResponses: 'fixtures', network: 'blocked', scenarios: [] }
let window
const deadline = setTimeout(() => finish(new Error('Startup smoke exceeded 40 seconds')), 40000)
function finish(error) {
  clearTimeout(deadline)
  report.passed = !error
  if (error) report.error = error.stack || String(error)
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (window && !window.isDestroyed()) window.destroy()
  app.exit(error ? 1 : 0)
}
async function snapshot() {
  return window.webContents.executeJavaScript(`({text:document.body.innerText,rootChildren:document.getElementById('root').childElementCount,mainOpacity:(()=>{const e=document.querySelector('.main-area .page-view');return e?Number(getComputedStyle(e).opacity):null})(),runtimeDialog:!!document.querySelector('.runtime-dialog-overlay'),bridgeFrozen:Object.isFrozen(window.videoAutoCut),descriptor:(()=>{const d=Object.getOwnPropertyDescriptor(window.videoAutoCut,'taskStatus');return {writable:d.writable,configurable:d.configurable}})()})`)
}
async function waitFor(check, timeout = 5000) {
  const end = Date.now() + timeout
  do { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)) } while (Date.now() < end)
  throw new Error('Expected renderer state did not appear')
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  const { IPC_INVOKE } = await import(pathToFileURL(path.join(appRoot, 'dist-electron/ipc-channels.js')).href)
  let loggedIn = true
  let accountId = 'fixture-A'
  let calls = []
  const auth = () => ({ loggedIn, user: loggedIn ? { id: accountId, username: accountId, balance: 0 } : null })
  const runtime = { ready: true, status: 'ready', installedVersion: '0.5.9', version: '0.5.9', configured: true }
  const update = { status: 'not-available', currentVersion: 'smoke', configured: false, canCheck: false, isPackaged: false, available: false, downloaded: false }
  for (const channel of Object.values(IPC_INVOKE)) ipcMain.handle(channel, () => {
    calls.push(channel)
    switch (channel) {
      case 'app:info': return { version: 'smoke', runtime }
      case 'auth:status': return auth()
      case 'auth:refresh': return { ok: true, auth: auth() }
      case 'auth:logout': loggedIn = false; return auth()
      case 'auth:captcha': return { ok: true, captchaToken: 'fixture', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }
      case 'runtime:status': return runtime
      case 'runtime:check': return runtime
      case 'update:status': return update
      case 'update:check': return { ok: true, status: update }
      case 'task:status': return { running: false }
      case 'env:read': return {}
      case 'runs:list': case 'voice:templates': case 'voice:registry': return []
      case 'window:mode': return { ok: true }
      default: throw new Error(`Unexpected business IPC in startup smoke: ${channel}`)
    }
  })
  window = new BrowserWindow({ show: false, width: 1440, height: 960, backgroundColor: '#0b0d10', webPreferences: { preload: path.join(appRoot, 'dist-electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  let errors = []
  window.webContents.on('console-message', (_event, ...args) => {
    const details = typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1] }
    if (details.level === 3 || details.level === 'error') errors.push(details.message)
  })
  window.webContents.on('preload-error', (_event, _preloadPath, error) => errors.push(String(error)))
  const load = async (name) => {
    calls = []; errors = []
    await window.loadFile(path.join(appRoot, 'dist/index.html'))
    const state = await waitFor(async () => {
      const value = await snapshot()
      return (errors.length || (loggedIn ? value.text.includes('当前流程') : value.text.includes('登录'))) && value
    })
    // Let mount effects and a later paint settle; the regression empties an initially mounted tree.
    await new Promise(resolve => setTimeout(resolve, 400))
    const final = await snapshot()
    const result = { name, ...final, errors: [...errors], calls: [...calls], visible: window.isVisible() }
    report.scenarios.push(result)
    fs.writeFileSync(path.join(output, `${name}.png`), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
    assert.equal(window.isVisible(), false, 'Capturing a test frame must never show the window')
    assert.equal(result.visible, false)
    assert.equal(final.bridgeFrozen, true)
    assert.deepEqual(final.descriptor, { writable: false, configurable: false })
    if (expectBroken) {
      assert.equal(final.rootChildren, 0)
      assert.ok(errors.some(error => /proxy/i.test(error) && /taskStatus/.test(error)), 'Must reproduce the exact frozen-bridge taskStatus exception')
    } else {
      assert.deepEqual(errors, [])
      assert.ok(final.rootChildren > 0)
      if (loggedIn) { assert.ok(final.text.includes('当前流程')); assert.ok(calls.includes('task:status')); assert.ok(final.mainOpacity >= 0.99); assert.equal(final.runtimeDialog, false) }
      else assert.ok(final.text.includes('登录'))
    }
    return state
  }
  await load('stored-account-A')
  if (!expectBroken) {
    // Exercise the actual account/logout UI without OS input or opening a visible window.
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="账号"]').click()`)
    await waitFor(() => window.webContents.executeJavaScript(`!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('退出登录'))`))
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('退出登录')).click()`)
    await waitFor(async () => (await snapshot()).text.includes('登录'))
    assert.equal(loggedIn, false)
    assert.deepEqual(errors, [])
    await load('logged-out')
    loggedIn = true; accountId = 'fixture-B'
    await load('stored-account-B')
  }
  finish()
}).catch(finish)
