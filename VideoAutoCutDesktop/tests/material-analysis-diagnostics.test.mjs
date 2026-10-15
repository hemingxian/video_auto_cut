import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyAnalysisFailure, recordAnalysisFailure, redactAnalysisOutput } from '../dist-electron/material-analysis-diagnostics.js'

test('distinguishes analysis failures without calling unknown failures network errors', () => {
  for (const [output, category] of [
    ['requests.exceptions.ReadTimeout: read timed out', 'timeout'],
    ['ModuleNotFoundError: No module named chromadb', 'dependency'],
    ['DashScopeAPIError HTTP 502 Bad Gateway', 'model_response'],
    ['HTTPError: 403 Forbidden', 'authentication'],
    ['HTTP 429 Too Many Requests', 'quota'],
    ['requests.exceptions.SSLError: EOF occurred', 'connection'],
    ['ffmpeg Invalid data found when processing input', 'media'],
    ['FileNotFoundError: no such file', 'file_missing'],
    ["Error: Invalid value for 'DIRECTORY': Path 'D:\\403\\SSL\\timeout\\素材.mp4' does not exist.", 'file_missing'],
    ["Error: Invalid value for 'DIRECTORY': Directory 'C:\\429\\missing' does not exist.", 'file_missing'],
    ['OSError: [WinError 206] The filename or extension is too long', 'path_too_long'],
    ['OSError: ENAMETOOLONG', 'path_too_long'],
    ['PermissionError: [WinError 5] Access is denied', 'file_access_denied'],
    ['EACCES: permission denied', 'file_access_denied'],
    ['Access denied', 'file_access_denied'],
    ['HTTP 403 Access denied', 'authentication'],
    ['status_code=429', 'quota'],
    ['RuntimeError: failed item 403 in batch 429', 'unknown'],
    ['RuntimeError: failed "D:\\403\\429\\SSL\\timeout\\HTTP 502.mp4"', 'unknown'],
    ['RuntimeError: database locked', 'unknown'],
  ]) assert.equal(classifyAnalysisFailure(output).category, category)
  assert.equal(classifyAnalysisFailure('', true).category, 'runtime_missing')
})

test('missing model credentials explain login recovery without treating filenames as credentials errors', () => {
  const failure = classifyAnalysisFailure('DashScopeAPIKeyError: DASHSCOPE_API_KEY is not set.')
  assert.equal(failure.category, 'authentication')
  assert.match(failure.message, /模型服务授权未就绪/)
  assert.match(failure.message, /重新登录/)
  assert.doesNotMatch(failure.message, /填写|API_KEY|SDK/)
  const source = 'D:\\素材\\DashScopeAPIKeyError DASHSCOPE_API_KEY is not set.mp4'
  assert.equal(classifyAnalysisFailure(`RuntimeError: failed '${source}'`).category, 'unknown')
  assert.equal(classifyAnalysisFailure(`Path '${source}' does not exist.`).category, 'file_missing')
})

const longWindowsSource = `D:\\素材\\${'较长目录\\'.repeat(55)}403.mp4`
const clickSourceMissing = (source) => `Error: Invalid value for 'DIRECTORY': Path '${source.replaceAll('\\', '\\\\')}' does not exist.`

function mockPathAccess(t, source, ordinary, extended) {
  const originalStat = fs.statSync
  const namespaced = path.win32.toNamespacedPath(source)
  t.mock.method(fs, 'statSync', (candidate, ...args) => {
    const state = candidate === source ? ordinary : candidate === namespaced ? extended : undefined
    if (!state) return originalStat(candidate, ...args)
    if (state === 'file' || state === 'directory') return { isFile: () => state === 'file' }
    throw Object.assign(new Error(state), { code: state })
  })
}

test('confirms a namespace access mismatch instead of assuming the source was deleted', (t) => {
  mockPathAccess(t, longWindowsSource, 'ENOENT', 'file')
  const failure = classifyAnalysisFailure(clickSourceMissing(longWindowsSource), false, { source: longWindowsSource })
  assert.equal(failure.category, 'path_too_long')
  assert.equal(failure.pathEvidence.ordinary, 'missing')
  assert.equal(failure.pathEvidence.extended, 'file')
  assert.match(failure.message, /扩展路径可以访问/)
  assert.match(failure.message, /较短目录/)
})

test('a genuinely missing long source remains file_missing', (t) => {
  mockPathAccess(t, longWindowsSource, 'ENOENT', 'ENOENT')
  const failure = classifyAnalysisFailure(clickSourceMissing(longWindowsSource), false, { source: longWindowsSource })
  assert.equal(failure.category, 'file_missing')
  assert.equal(failure.pathEvidence.extended, 'missing')
  assert.doesNotMatch(failure.message, /路径过长|文件仍在本机/)
})

test('existing long source rejected by the engine reports access incompatibility, not proven path length cause', (t) => {
  mockPathAccess(t, longWindowsSource, 'file', 'file')
  const failure = classifyAnalysisFailure(clickSourceMissing(longWindowsSource), false, { source: longWindowsSource })
  assert.equal(failure.category, 'file_path_access')
  assert.match(failure.message, /已确认素材文件在本机存在/)
  assert.match(failure.message, new RegExp(`${longWindowsSource.length} 个字符`))
  assert.doesNotMatch(failure.message, /路径过长|普通路径无法访问/)
})

test('a short existing source does not get a long-path diagnosis', (t) => {
  const source = 'D:\\素材\\403.mp4'
  mockPathAccess(t, source, 'file', 'file')
  const failure = classifyAnalysisFailure(clickSourceMissing(source), false, { source })
  assert.equal(failure.category, 'file_path_access')
  assert.match(failure.message, /重新选择素材/)
  assert.doesNotMatch(failure.message, /较短目录|路径过长/)
})

test('source stat permission evidence overrides a misleading Click missing-file report', (t) => {
  mockPathAccess(t, longWindowsSource, 'EACCES', 'EACCES')
  const failure = classifyAnalysisFailure(clickSourceMissing(longWindowsSource), false, { source: longWindowsSource })
  assert.equal(failure.category, 'file_access_denied')
  assert.match(failure.message, /读取权限/)
})

test('source context cannot turn a missing dependency or model failure into a long-path failure', (t) => {
  let statCalls = 0
  t.mock.method(fs, 'statSync', () => { statCalls += 1; throw new Error('must not inspect unrelated source') })
  for (const [output, expected] of [
    ["FileNotFoundError: [Errno 2] No such file or directory: 'D:\\tools\\ffmpeg.exe'", 'file_missing'],
    ['HTTP 403 Forbidden', 'authentication'],
    ['requests.exceptions.ReadTimeout: read timed out', 'timeout'],
  ]) {
    assert.equal(classifyAnalysisFailure(output, false, { source: longWindowsSource }).category, expected)
  }
  assert.equal(statCalls, 0)
})

test('an actual local source is probed for Click rejection and the evidence is retained in the diagnostic log', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-diagnostic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '403.mp4')
  fs.writeFileSync(source, 'existing source fixture')
  const message = recordAnalysisFailure(root, {
    source, startedAt: new Date().toISOString(), command: 'python.exe', args: ['index', source],
    code: 2, stdout: '', stderr: clickSourceMissing(source),
  })
  const dir = path.join(root, 'logs', 'material-analysis')
  const log = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'))
  assert.equal(log.category, 'file_path_access')
  assert.equal(log.pathEvidence.ordinary, 'file')
  assert.equal(log.code, 2)
  assert.match(message, /文件在本机存在/)
  assert.match(message, /诊断日志/)
  assert.equal(log.stderr, clickSourceMissing(source))
})

test('retains full diagnostic output, timing and exit status without credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-diagnostic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const message = recordAnalysisFailure(root, {
    source: '素材.mp4', startedAt: new Date().toISOString(), command: 'python.exe', args: ['index', '素材.mp4'],
    code: 1, stdout: 'stage: embedding', stderr: 'HTTP 502 request_id=req-123\nAuthorization: Bearer sk-private\nhttps://example.com/video?signature=secret',
  })
  const dir = path.join(root, 'logs', 'material-analysis')
  const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')
  const log = JSON.parse(raw)
  assert.equal(log.code, 1)
  assert.equal(log.category, 'model_response')
  assert.match(log.stderr, /request_id=req-123/)
  assert.ok(log.durationMs >= 0)
  assert.match(message, /诊断日志/)
  assert.doesNotMatch(raw, /sk-private|signature=secret/)
  assert.doesNotMatch(redactAnalysisOutput('api_key=private-value'), /private-value/)
})

test('log write failure preserves actual analysis cause', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-diagnostic-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'logs'), 'not a directory')
  const message = recordAnalysisFailure(root, { source: 'a', startedAt: new Date().toISOString(), command: '', args: [], code: null, stdout: '', stderr: '', runtimeMissing: true })
  assert.match(message, /引擎未就绪/)
  assert.match(message, /日志写入失败/)
})
