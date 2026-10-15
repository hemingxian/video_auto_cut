import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createMaterialsService } from '../dist-electron/materials-service.js'
import { createMaterialLocalStore } from '../dist-electron/material-local-store.js'
import { sentryFilePath } from '../dist-electron/sentry-path.js'

function isInside(target, boundary) {
  const relative = path.relative(path.resolve(boundary), path.resolve(target))
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function samePath(first, second) {
  return path.resolve(String(first || '')).toLocaleLowerCase()
    === path.resolve(String(second || '')).toLocaleLowerCase()
}

function createFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-raw-material-service-'))
  const dataRoot = fs.realpathSync(root)
  const materialsDir = path.join(dataRoot, 'video', 'materials')
  const runsDir = path.join(dataRoot, 'video', 'runs')
  const missingRuntime = path.join(dataRoot, 'missing-runtime')
  fs.mkdirSync(materialsDir, { recursive: true })
  fs.mkdirSync(runsDir, { recursive: true })
  const ownedIdentityStore = overrides.createIdentityStore?.({ dataRoot, materialsDir, runsDir })

  t.after(() => {
    ownedIdentityStore?.close()
    assert.equal(isInside(dataRoot, fs.realpathSync(os.tmpdir())), true)
    fs.rmSync(dataRoot, { recursive: true, force: true })
  })

  const assertInsideWorkspace = (target) => {
    const resolved = path.resolve(String(target || ''))
    if (!isInside(resolved, dataRoot)) throw new Error('path is outside the test workspace')
    return resolved
  }
  const safeRemoveDirectory = (directory) => {
    const resolved = assertInsideWorkspace(directory)
    const existed = fs.existsSync(resolved)
    fs.rmSync(resolved, { recursive: true, force: true })
    return existed
  }
  const safeRemoveFile = (file) => {
    const resolved = assertInsideWorkspace(file)
    const existed = fs.existsSync(resolved)
    fs.rmSync(resolved, { force: true })
    return existed
  }

  const service = createMaterialsService({
    dataRoot,
    materialsDir,
    runsDir,
    generatedRecordsPath: path.join(materialsDir, 'generated', 'records.json'),
    getVideoAutoRoot: () => missingRuntime,
    getPythonPath: () => path.join(missingRuntime, 'python.exe'),
    getSentrySearchPaths: overrides.getSentrySearchPaths || (() => ({
      exe: path.join(missingRuntime, 'sentrysearch.exe'),
      python: path.join(missingRuntime, 'python.exe'),
      entry: path.join(missingRuntime, 'sentrysearch.py'),
    })),
    listRuns: overrides.listRuns || (() => []),
    createVideoAutoEnv: () => ({ ...process.env }),
    assertInsideWorkspace,
    resolveExistingOrParent: (target) => path.resolve(String(target || '')),
    isInsideDir: isInside,
    safeRemoveFile,
    safeRemoveDirectory,
    samePath,
    isRuntimeUsable: overrides.isRuntimeUsable || (() => false),
    showOpenDialog: overrides.showOpenDialog
      || (async () => ({ canceled: true, filePaths: [] })),
    send: overrides.send || (() => {}),
    identityStore: ownedIdentityStore || overrides.identityStore,
    cloudSemanticSearch: overrides.cloudSemanticSearch,
    ensureCloudMaterialAvailable: overrides.ensureCloudMaterialAvailable,
    onMaterialsImported: overrides.onMaterialsImported,
    onDownloadedMaterials: overrides.onDownloadedMaterials,
    hasExistingAnalysis: overrides.hasExistingAnalysis,
    onMaterialAnalysisReady: overrides.onMaterialAnalysisReady,
    analysisAbortSignal: overrides.analysisAbortSignal,
    onMaterialFolderCreated: overrides.onMaterialFolderCreated,
    onMaterialFolderDeleted: overrides.onMaterialFolderDeleted,
  })

  return {
    dataRoot,
    materialsDir,
    runsDir,
    service,
  }
}

function writeFile(file, contents = 'test-video') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, 'utf8')
  return fs.realpathSync(file)
}

function findFolder(listing, name) {
  const folder = listing.folders.find((item) => item.name === name)
  assert.ok(folder, `missing folder: ${name}`)
  return folder
}

test('Sentry file arguments support long Windows drive and UNC paths without changing existing short aliases', () => {
  const longDrive = 'D:\\素材库\\' + '项目目录\\'.repeat(52) + '素材.mp4'
  const longUnc = '\\\\server\\share\\' + '项目目录\\'.repeat(52) + '素材.mp4'
  for (const source of [longDrive, longUnc]) {
    const converted = sentryFilePath(source, 'win32')
    assert.equal(converted, path.win32.toNamespacedPath(source))
    assert.equal(sentryFilePath(converted, 'win32'), converted)
    assert.equal(sentryFilePath(source, 'linux'), source)
  }
  for (const source of ['D:\\素材库\\短路径.mp4', '\\\\server\\share\\短路径.mp4', 'relative.mp4']) {
    assert.equal(sentryFilePath(source, 'win32'), source)
  }
})

test('long material paths reach the index process while status and verification retain the original identity', async (t) => {
  const events = []
  const verified = []
  let probe = ''
  const fixture = createFixture(t, {
    send: (_channel, event) => events.push(event),
    getSentrySearchPaths: () => ({ exe: '', python: process.execPath, entry: probe }),
    hasExistingAnalysis: async file => {
      verified.push(file)
      return fs.existsSync(`${file}.verified`)
    },
  })
  probe = writeFile(path.join(fixture.dataRoot, 'long-path-probe.mjs'), `
import fs from 'node:fs';
const source = process.argv[3];
if (process.argv[2] !== 'index' || !fs.statSync(source).isFile()) process.exit(2);
fs.writeFileSync(source + '.verified', JSON.stringify({ source, encoding: process.env.PYTHONIOENCODING }));
`)
  const source = writeFile(path.join(fixture.materialsDir, '项目素材子文件夹'.repeat(10),
    '素材范围子文件夹'.repeat(10), '原始素材目录'.repeat(8), '真实路径包含中文和 空格.mp4'))
  assert.ok(source.length > 300)
  const result = await fixture.service.analyzeMaterial({ path: source })
  assert.equal(result.ok, true)
  const received = JSON.parse(fs.readFileSync(`${source}.verified`, 'utf8'))
  assert.equal(received.source, process.platform === 'win32' ? path.toNamespacedPath(source) : source)
  assert.equal(received.encoding, 'utf-8')
  assert.deepEqual(verified, [source, source])
  assert.deepEqual(events.filter(event => event.type === 'analysis-status').map(event => [event.path, event.status]),
    [[source, 'analyzing'], [source, 'ready']])
  await fixture.service.stopMaterialWork()
})

test('missing analysis engine returns the same specific error to UI and persists diagnostics', async (t) => {
  const events = []
  const fixture = createFixture(t, { send: (_channel, event) => events.push(event) })
  const file = writeFile(path.join(fixture.materialsDir, '待分析.mp4'))
  const result = await fixture.service.analyzeMaterial({ path: file })
  assert.equal(result.ok, false)
  assert.match(result.message, /分析引擎未就绪/)
  assert.doesNotMatch(result.message, /检查网络/)
  assert.equal(events.find(event => event.type === 'analysis-status').message, result.message)
  const logDir = path.join(fixture.dataRoot, 'logs', 'material-analysis')
  const log = JSON.parse(fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), 'utf8'))
  assert.equal(log.category, 'runtime_missing')
  assert.equal(log.code, null)
  assert.match(log.stderr, /missing-runtime/)
})

test('an existing H264 copy alone never certifies downloaded material analysis', async (t) => {
  const statuses = []
  const fixture = createFixture(t, {
    identityStore: {
      getOrCreateFolder: () => 'fld_downloads',
      describeKnownFile: file => ({ ...file, analysisStatus: 'pending' }),
      setAnalysisStatusForFile: (...args) => statuses.push(args),
    },
    hasExistingAnalysis: async () => false,
  })
  const runPath = path.join(fixture.runsDir, 'run-no-vectors')
  writeFile(path.join(runPath, 'raw', 'shot', 'source.mp4'))
  writeFile(path.join(runPath, 'raw', 'shot', '_indexed_h264', '001_source.mp4'))
  const result = await fixture.service.processDownloadedMaterials(runPath, { markIndexedReady: true, analyzeMissing: false })
  assert.equal(result.ready, 0)
  assert.equal(result.pending, 1)
  assert.deepEqual(statuses, [])
})

test('import and backup requests share a serial verified analysis job and wake waiting backups', async (t) => {
  const statuses = new Map()
  const events = []
  const ready = []
  let probe = ''
  const fixture = createFixture(t, {
    identityStore: {
      getOrCreateFolder: () => 'fld_local',
      describeKnownFile: file => ({ ...file, materialId: path.basename(file.path),
        assetId: path.basename(file.path), assetVersion: 1, analysisStatus: statuses.get(file.path) || 'pending' }),
      setAnalysisStatusForFile: (file, status) => { statuses.set(file, status); events.push([path.basename(file), status]) },
    },
    getSentrySearchPaths: () => ({ exe: '', python: process.execPath, entry: probe }),
    hasExistingAnalysis: async file => fs.existsSync(`${file}.verified`),
    onMaterialAnalysisReady: file => { ready.push(path.basename(file.path)) },
  })
  probe = writeFile(path.join(fixture.dataRoot, 'analysis-serial-probe.mjs'), `
import fs from 'node:fs';
const file=process.argv.find(arg=>arg.endsWith('.mp4'));
fs.appendFileSync(file+'.calls','called\\n');
setTimeout(()=>fs.writeFileSync(file+'.verified','complete'),100);
`)
  const first = writeFile(path.join(fixture.materialsDir, 'first.mp4'))
  const second = writeFile(path.join(fixture.materialsDir, 'second.mp4'))
  await Promise.all([
    fixture.service.analyzeMaterialsForBackup([first, second]),
    fixture.service.analyzeMaterial({ path: first }),
    fixture.service.analyzeMaterialsForBackup([first]),
  ])
  assert.equal(fs.readFileSync(`${first}.calls`, 'utf8'), 'called\n')
  assert.equal(fs.readFileSync(`${second}.calls`, 'utf8'), 'called\n')
  assert.deepEqual(events, [['first.mp4', 'analyzing'], ['first.mp4', 'ready'], ['second.mp4', 'analyzing'], ['second.mp4', 'ready']])
  assert.deepEqual(ready, ['first.mp4', 'second.mp4'])
  await fixture.service.stopMaterialWork()
})

test('a missing file in a backup selection does not block analysis of valid files', async (t) => {
  const statuses = []
  const events = []
  const ready = []
  const fixture = createFixture(t, {
    identityStore: {
      getOrCreateFolder: () => 'fld_local',
      describeKnownFile: file => ({ ...file, assetId: path.basename(file.path), assetVersion: 1 }),
      setAnalysisStatusForFile: (...args) => statuses.push(args),
    },
    hasExistingAnalysis: async () => true,
    onMaterialAnalysisReady: file => ready.push(file.path),
    send: (_channel, event) => events.push(event),
  })
  const first = writeFile(path.join(fixture.materialsDir, 'first.mp4'))
  const missing = path.join(fixture.materialsDir, 'removed.mp4')
  const second = writeFile(path.join(fixture.materialsDir, 'second.mp4'))
  await fixture.service.analyzeMaterialsForBackup([first, missing, second])
  assert.deepEqual(ready, [first, second])
  assert.deepEqual(statuses.map(([file, status]) => [file, status]), [[missing, 'failed'], [first, 'ready'], [second, 'ready']])
  assert.match(events.find(event => event.path === missing)?.message, /文件不存在/)
  await fixture.service.stopMaterialWork()
})

test('shutdown cancels the owned analysis process and leaves pending work for restart', async (t) => {
  const statuses = new Map()
  let probe = ''
  const signal = new AbortController()
  const identityStore = {
    getOrCreateFolder: () => 'fld_local',
    describeKnownFile: file => ({ ...file, materialId: path.basename(file.path), assetId: path.basename(file.path),
      assetVersion: 1, analysisStatus: statuses.get(file.path) || 'pending' }),
    setAnalysisStatusForFile: (file, status) => { statuses.set(file, status) },
  }
  const fixture = createFixture(t, { identityStore, analysisAbortSignal: signal.signal,
    hasExistingAnalysis: async () => false,
    getSentrySearchPaths: () => ({ exe: '', python: process.execPath, entry: probe }),
  })
  probe = writeFile(path.join(fixture.dataRoot, 'analysis-cancel-probe.mjs'), `
import fs from 'node:fs';
const file=process.argv.find(arg=>arg.endsWith('.mp4'));
fs.writeFileSync(file+'.pid',String(process.pid));
setInterval(()=>{},1000);
`)
  const first = writeFile(path.join(fixture.materialsDir, 'first.mp4'))
  const second = writeFile(path.join(fixture.materialsDir, 'second.mp4'))
  const pending = fixture.service.analyzeMaterialsForBackup([first, second])
  const deadline = Date.now() + 5000
  while (!fs.existsSync(`${first}.pid`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fs.existsSync(`${first}.pid`), true)
  const pid = Number(fs.readFileSync(`${first}.pid`, 'utf8'))
  signal.abort()
  await fixture.service.stopMaterialWork()
  await pending
  assert.equal(statuses.get(first), 'pending')
  assert.equal([...statuses.values()].includes('failed'), false)
  assert.equal(fs.existsSync(`${second}.pid`), false)
  assert.throws(() => process.kill(pid, 0))
})

for (const restoreSucceeds of [true, false]) {
  test(`existing cloud analysis restores indexes without invoking the model (restore=${restoreSucceeds})`, async (t) => {
    const record = { materialId: 'mat_ready', cloudStatus: 'ready', cloudAnalysisStatus: 'ready', analysisStatus: 'pending' }
    let restores = 0
    const fixture = createFixture(t, {
      identityStore: {
        getOrCreateFolder: () => 'fld_test',
        getMaterialCloudFileById: () => record,
        describeKnownFile: file => ({ ...file, ...record }),
        setAnalysisStatusForFile: () => assert.fail('must not start a new model analysis'),
      },
      ensureCloudMaterialAvailable: async () => {
        restores++
        if (!restoreSucceeds) throw Error('restore temporarily unavailable')
        record.analysisStatus = 'ready'
        return { ok: true, path: record.localPath }
      },
      getSentrySearchPaths: () => { assert.fail('must reuse cloud results instead of calling model') },
    })
    record.localPath = writeFile(path.join(fixture.materialsDir, 'ready.mp4'))
    const result = await fixture.service.analyzeMaterial({ materialId: record.materialId })
    assert.equal(restores, 1)
    assert.equal(result.ok, restoreSucceeds)
    if (!restoreSucceeds) assert.match(result.message, /无需重复分析/)
  })
}

test('cloud analysis downloads a missing old path before passing the restored file to analysis', async (t) => {
  const record = { materialId: 'mat_cloud', cloudStatus: 'ready', localPath: 'Z:/old-install/deleted.mp4' }
  const statuses = []
  let downloads = 0
  let analyzedPath = ''
  const fixture = createFixture(t, {
    identityStore: {
      getOrCreateFolder: () => 'fld_test',
      getMaterialCloudFileById: () => record,
      describeKnownFile: (file) => { analyzedPath = file.path; return { ...file, analysisStatus: 'pending' } },
      setAnalysisStatusForFile: (file, status) => statuses.push([file, status]),
    },
    ensureCloudMaterialAvailable: async (id) => {
      assert.equal(id, record.materialId)
      downloads += 1
      record.localPath = writeFile(path.join(fixture.materialsDir, 'restored.mp4'))
      return { ok: true, path: record.localPath }
    },
    getSentrySearchPaths: () => ({ exe: '', python: process.execPath, entry: path.join(fixture.dataRoot, 'analysis-probe.mjs') }),
  })
  // A unit process probe verifies the analysis input; actual model validation is separate.
  fs.writeFileSync(path.join(fixture.dataRoot, 'analysis-probe.mjs'), "import fs from 'node:fs'; if (!process.argv.some(a => a.endsWith('restored.mp4') && fs.existsSync(a))) process.exit(1)")
  const result = await fixture.service.analyzeMaterial({ materialId: record.materialId, path: record.localPath })
  assert.equal(result.ok, true)
  assert.equal(downloads, 1)
  assert.equal(analyzedPath, record.localPath)
  assert.deepEqual(statuses.map((item) => item[1]), ['analyzing', 'ready'])
})

test('cloud download failure does not start analysis or report a model failure', async (t) => {
  const fixture = createFixture(t, {
    identityStore: {
      getOrCreateFolder: () => 'fld_test',
      getMaterialCloudFileById: () => ({ materialId: 'mat_cloud', cloudStatus: 'ready', localPath: 'Z:/deleted.mp4' }),
      describeKnownFile: () => assert.fail('analysis must not start'),
    },
    ensureCloudMaterialAvailable: async () => ({ ok: false, message: '云端下载暂时不可用' }),
  })
  assert.deepEqual(await fixture.service.analyzeMaterial({ materialId: 'mat_cloud' }), { ok: false, message: '云端下载暂时不可用' })
})

test('missing local material without a cloud copy returns an actionable error', async (t) => {
  const fixture = createFixture(t)
  const result = await fixture.service.analyzeMaterial({ path: path.join(fixture.materialsDir, 'deleted.mp4') })
  assert.equal(result.ok, false)
  assert.match(result.message, /本地素材文件不存在/)
  assert.doesNotMatch(result.message, /ENOENT|模型/)
})

test('raw download folders stay read-only through the service boundary', async (t) => {
  const fixture = createFixture(t)
  const source = writeFile(path.join(
    fixture.runsDir,
    'run-1',
    'raw',
    'shot_001',
    'source.mp4',
  ))

  const root = fixture.service.browseMaterials()
  const downloads = fixture.service.browseMaterials({
    folderId: findFolder(root, '云端素材').id,
  })
  const batch = fixture.service.browseMaterials({
    folderId: findFolder(downloads, 'run-1').id,
  })
  const shot = findFolder(batch, 'shot_001')

  const renamed = await fixture.service.renameMaterialFolder({
    folderId: shot.id,
    name: 'renamed',
  })
  const deleted = await fixture.service.deleteMaterialFolder({ folderId: shot.id })

  assert.equal(renamed.ok, false)
  assert.equal(deleted.ok, false)
  assert.match(renamed.message || '', /不可重命名或删除/)
  assert.match(deleted.message || '', /不可重命名或删除/)
  assert.equal(fs.existsSync(source), true)
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(source)), 'renamed')), false)
})

test('deletion preview is identity-based and batch deletion reports each target independently', async (t) => {
  const deleted = []
  let folderSequence = 0
  const identityStore = {
    getOrCreateFolder: () => `fld_test_${folderSequence++}`,
    getMaterialCloudFileByPath: (filePath) => ({
      materialId: `mat_${path.basename(filePath)}`,
      assetId: `asset_${path.basename(filePath)}`,
      assetVersion: 1,
      sourceSha256: 'c'.repeat(64),
      sourceSize: 10,
      displayName: path.basename(filePath),
      mimeType: 'video/mp4',
      origin: 'user_upload',
      addedFrom: 'user_import',
      revision: 1,
      cloudRevision: 0,
      localStatus: 'present',
      analysisStatus: 'ready',
      cloudAnalysisStatus: 'ready',
      cloudStatus: 'not_uploaded',
      publicationStatus: 'private',
      folderId: 'fld_test_0',
      localPath: filePath,
    }),
    getDeletionImpact: (materialIds, folderIds) => ({
      materialCount: materialIds.length,
      folderCount: folderIds.length,
      localFileCount: materialIds.length,
      cloudCopyCount: 0,
      publicMaterialCount: 0,
      taskReferenceCount: 1,
      canDelete: true,
      blockers: [],
    }),
    deleteFile: (filePath) => { deleted.push(filePath) },
  }
  const fixture = createFixture(t, { identityStore })
  const first = writeFile(path.join(fixture.materialsDir, 'first.mp4'))
  const second = writeFile(path.join(fixture.materialsDir, 'second.mp4'))
  const outside = path.join(path.dirname(fixture.dataRoot), 'outside-delete.mp4')

  const preview = fixture.service.previewMaterialDeletion({ paths: [first, second] })
  assert.equal(preview.ok, true)
  assert.equal(preview.materialCount, 2)
  assert.equal(preview.taskReferenceCount, 1)

  const result = await fixture.service.deleteMaterials({ paths: [first, outside, second] })
  assert.equal(result.ok, false)
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.results.map((item) => item.ok), [true, false, true])
  assert.deepEqual(deleted.map((item) => path.basename(item)), ['first.mp4', 'second.mp4'])
})

test('deleting a local copy preserves the cloud identity and removes indexed device files', (t) => {
  let localPath = ''
  const removed = []
  const identityStore = {
    getOrCreateFolder: () => 'fld_local_copy',
    getMaterialCloudFileById: () => ({
      materialId: 'mat_local_copy',
      assetId: 'asset_local_copy',
      assetVersion: 1,
      sourceSha256: 'd'.repeat(64),
      sourceSize: 10,
      displayName: 'local-copy.mp4',
      mimeType: 'video/mp4',
      origin: 'user_upload',
      addedFrom: 'user_import',
      revision: 3,
      cloudRevision: 3,
      localStatus: 'present',
      analysisStatus: 'ready',
      cloudAnalysisStatus: 'ready',
      cloudStatus: 'ready',
      publicationStatus: 'private',
      folderId: 'fld_local_copy',
      localPath,
    }),
    removeLocalCopy: (materialId) => { removed.push(materialId) },
  }
  const fixture = createFixture(t, { identityStore })
  localPath = writeFile(path.join(fixture.materialsDir, 'local-copy.mp4'))

  const result = fixture.service.deleteLocalMaterialCopy({ materialId: 'mat_local_copy' })
  assert.equal(result.ok, true)
  assert.equal(result.removedFile, true)
  assert.equal(fs.existsSync(localPath), false)
  assert.deepEqual(removed, ['mat_local_copy'])
})

test('downloaded Pexels originals reuse completed indexed analysis and enter backup callback', async (t) => {
  const statuses = new Map()
  const queued = []
  const identityStore = {
    getOrCreateFolder: () => 'fld_downloads',
    describeKnownFile: (file) => ({
      ...file,
      materialId: `mat_${path.basename(file.path)}`,
      assetId: `asset_${path.basename(file.path)}`,
      assetVersion: 1,
      sourceSha256: 'a'.repeat(64),
      localStatus: 'present',
      analysisStatus: statuses.get(file.path) || 'pending',
      cloudStatus: 'not_uploaded',
    }),
    setAnalysisStatusForFile: (file, status) => { statuses.set(file, status) },
  }
  const fixture = createFixture(t, {
    identityStore,
    hasExistingAnalysis: async () => true,
    onDownloadedMaterials: (files) => { queued.push(...files) },
  })
  const runPath = path.join(fixture.runsDir, 'run-pexels')
  const source = writeFile(path.join(runPath, 'raw', 'shot_001', 'source.mp4'))
  writeFile(path.join(runPath, 'raw', 'shot_001', '_indexed_h264', '001_source.mp4'))

  const result = await fixture.service.processDownloadedMaterials(runPath, {
    markIndexedReady: true,
    analyzeMissing: false,
  })

  assert.equal(result.ok, true)
  assert.equal(result.ready, 1)
  assert.equal(statuses.get(source), 'ready')
  assert.deepEqual(queued.map((file) => file.path), [source])
})

test('incremental task registration uses current raw receipts and excludes obsolete or indexed cache copies', async (t) => {
  const queued = []
  const identityStore = {
    getOrCreateFolder: () => 'fld_downloads',
    describeKnownFile: file => ({ ...file, materialId: `mat_${path.basename(file.path)}`, localStatus: 'present', analysisStatus: 'ready', cloudStatus: 'not_uploaded' }),
  }
  const fixture = createFixture(t, { identityStore, onDownloadedMaterials: files => queued.push(...files) })
  const project = path.join(fixture.runsDir, '20260915', 'project')
  const runPath = path.join(project, '.videoautocut', 'runs', 'run_incremental')
  const source = writeFile(path.join(runPath, 'raw', 'shot-id-hash', 'input-hash', '01 · A', 'source.mp4'))
  writeFile(path.join(runPath, 'raw', 'shot-id-hash', 'old-input', '01 · A', 'old.mp4'))
  writeFile(path.join(runPath, 'raw', 'shot-id-hash', 'input-hash', '01 · A', '_indexed_h264', '001_source.mp4'))
  writeFile(path.join(project, '分镜视频', 'old-project.mp4'))
  fs.writeFileSync(path.join(runPath, 'shots.json'), JSON.stringify({ task_revision: 3, shots: [{ shot_id: 'a' }] }))
  fs.writeFileSync(path.join(runPath, 'incremental.json'), JSON.stringify({ schema_version: 1, records: { 'download:a': { files: { [source]: 'hash' } } } }))
  const result = await fixture.service.processDownloadedMaterials(runPath, { analyzeMissing: false })
  assert.equal(result.ok, true)
  assert.equal(result.ready, 1)
  assert.deepEqual(queued.map(file => file.path), [source])
})

test('interrupted downloaded-material analysis resumes from local status', async (t) => {
  const statuses = new Map()
  const identityStore = {
    getOrCreateFolder: () => 'fld_downloads',
    describeKnownFile: (file) => ({
      ...file,
      materialId: `mat_${path.basename(file.path)}`,
      assetId: `asset_${path.basename(file.path)}`,
      assetVersion: 1,
      sourceSha256: 'b'.repeat(64),
      localStatus: 'present',
      analysisStatus: statuses.get(file.path) || 'analyzing',
      cloudStatus: 'not_uploaded',
    }),
    setAnalysisStatusForFile: (file, status) => { statuses.set(file, status) },
  }
  let sentryEntry = ''
  const fixture = createFixture(t, {
    identityStore,
    getSentrySearchPaths: () => ({
      exe: path.join(fixture.dataRoot, 'missing-sentry.exe'),
      python: process.execPath,
      entry: sentryEntry,
    }),
  })
  sentryEntry = path.join(fixture.dataRoot, 'fake-sentry.mjs')
  fs.writeFileSync(sentryEntry, 'process.exit(0)')
  const runPath = path.join(fixture.runsDir, 'run-interrupted')
  const source = writeFile(path.join(runPath, 'raw', 'shot_001', 'source.mp4'))
  statuses.set(source, 'analyzing')

  const result = await fixture.service.processDownloadedMaterials(runPath, {
    markIndexedReady: true,
    analyzeMissing: true,
  })

  assert.equal(result.ok, true)
  assert.equal(statuses.get(source), 'ready')
})

test('startup removes abandoned imports and resumes analysis and backup policy for user materials', async (t) => {
  const statuses = new Map()
  const resumedBackups = []
  const identityStore = {
    getOrCreateFolder: () => 'fld_user_materials',
    describeKnownFile: (file) => ({
      ...file,
      materialId: `mat_${path.basename(file.path)}`,
      assetId: `asset_${path.basename(file.path)}`,
      assetVersion: 1,
      sourceSha256: 'd'.repeat(64),
      localStatus: 'present',
      analysisStatus: statuses.get(file.path) || 'analyzing',
      cloudStatus: 'not_uploaded',
    }),
    setAnalysisStatusForFile: (file, status) => { statuses.set(file, status) },
  }
  let sentryEntry = ''
  const fixture = createFixture(t, {
    identityStore,
    getSentrySearchPaths: () => ({
      exe: path.join(fixture.dataRoot, 'missing-sentry.exe'),
      python: process.execPath,
      entry: sentryEntry,
    }),
    onMaterialsImported: (files) => { resumedBackups.push(...files) },
    onDownloadedMaterials: () => {},
  })
  const source = writeFile(path.join(fixture.materialsDir, 'resumable-user.mp4'))
  statuses.set(source, 'analyzing')
  sentryEntry = writeFile(path.join(fixture.dataRoot, 'fake-user-sentry.mjs'), 'process.exit(0)')
  const abandonedSession = path.join(fixture.materialsDir, '.staging', 'abandoned-session')
  writeFile(path.join(abandonedSession, 'partial.mp4'), 'partial')

  await fixture.service.resumePendingMaterialWork()

  assert.equal(statuses.get(source), 'ready')
  assert.deepEqual(resumedBackups.map((file) => file.path), [source])
  assert.equal(fs.existsSync(abandonedSession), false)
})

test('material file operations reject generated files and task output files', async (t) => {
  const fixture = createFixture(t)
  const generated = writeFile(path.join(
    fixture.materialsDir,
    'generated',
    'generated-output.mp4',
  ))
  const clip = writeFile(path.join(
    fixture.runsDir,
    'run-1',
    'clips',
    'shot_001',
    'clip.mp4',
  ))
  const finalClip = writeFile(path.join(
    fixture.runsDir,
    'run-1',
    'final_clips',
    'final.mp4',
  ))

  for (const file of [generated, clip, finalClip]) {
    await assert.rejects(fixture.service.deleteMaterial(file), /素材目录/)
    const renamed = await fixture.service.renameMaterial({ path: file, name: 'renamed' })
    assert.equal(renamed.ok, false)
    assert.match(renamed.message || '', /素材目录/)
    assert.equal(fs.existsSync(file), true)
  }
})

test('renaming and deleting raw videos also removes their hidden indexed copies', async (t) => {
  const fixture = createFixture(t)
  const shotDirectory = path.join(fixture.runsDir, 'run-1', 'raw', 'shot_001')
  const first = writeFile(path.join(shotDirectory, 'a-source.mp4'))
  const second = writeFile(path.join(shotDirectory, 'b-source.webm'))
  const firstIndexed = writeFile(path.join(shotDirectory, '_indexed_h264', '001_a-source.mp4'))
  const secondIndexed = writeFile(path.join(shotDirectory, '_indexed_h264', '002_b-source.mp4'))

  const renamed = await fixture.service.renameMaterial({
    path: first,
    name: 'renamed-source',
  })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.index?.skipped, true)
  assert.equal(fs.existsSync(first), false)
  assert.equal(fs.existsSync(path.join(shotDirectory, 'renamed-source.mp4')), true)
  assert.equal(fs.existsSync(firstIndexed), false)

  const deleted = await fixture.service.deleteMaterial(second)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.index?.skipped, true)
  assert.equal(fs.existsSync(second), false)
  assert.equal(fs.existsSync(secondIndexed), false)
})

test('creates writable user folders and imports videos into the selected user directory', async (t) => {
  let selectedPaths = []
  const fixture = createFixture(t, {
    showOpenDialog: async () => ({ canceled: false, filePaths: selectedPaths }),
  })
  const source = writeFile(path.join(fixture.dataRoot, 'incoming', 'camera.mp4'), 'camera-video')
  selectedPaths = [source]

  const root = fixture.service.browseMaterials()
  const userNode = findFolder(root, '本地素材')
  const created = fixture.service.createMaterialFolder({
    parentFolderId: userNode.id,
    name: '项目素材',
  })

  assert.equal(created.ok, true)
  assert.deepEqual(
    {
      name: created.folder?.name,
      canCreate: created.folder?.canCreate,
      canRename: created.folder?.canRename,
      canDelete: created.folder?.canDelete,
      folderCount: created.folder?.folderCount,
      videoCount: created.folder?.videoCount,
    },
    {
      name: '项目素材',
      canCreate: true,
      canRename: true,
      canDelete: true,
      folderCount: 0,
      videoCount: 0,
    },
  )

  const imported = await fixture.service.importMaterials(null, {
    folderId: created.folder.id,
  })
  const importedPath = path.join(fixture.materialsDir, '项目素材', 'camera.mp4')
  assert.equal(imported.length, 1)
  assert.equal(imported[0].path, fs.realpathSync(importedPath))
  assert.equal(fs.readFileSync(importedPath, 'utf8'), 'camera-video')
  assert.deepEqual(
    fixture.service.browseMaterials({ folderId: created.folder.id }).files
      .map(({ name }) => name),
    ['camera.mp4'],
  )

  const nested = fixture.service.createMaterialFolder({
    parentFolderId: created.folder.id,
    name: '子目录',
  })
  assert.equal(nested.ok, true)
  assert.equal(
    fixture.service.browseMaterials({ folderId: nested.folder.id }).current.canCreate,
    true,
  )

  const renamed = await fixture.service.renameMaterialFolder({
    folderId: created.folder.id,
    name: 'project-renamed',
  })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.folder?.name, 'project-renamed')
  assert.equal(fs.existsSync(path.join(fixture.materialsDir, '项目素材')), false)
  assert.equal(
    fs.existsSync(path.join(fixture.materialsDir, 'project-renamed', 'camera.mp4')),
    true,
  )

  const deleted = await fixture.service.deleteMaterialFolder({
    folderId: renamed.folder.id,
  })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.parentId, userNode.id)
  assert.equal(fs.existsSync(path.join(fixture.materialsDir, 'project-renamed')), false)
})

test('local download folders support editing and return before background cloud cleanup', async (t) => {
  let selectedPaths = []
  let deleteCallbackCalled = false
  const fixture = createFixture(t, {
    showOpenDialog: async () => ({ canceled: false, filePaths: selectedPaths }),
    onMaterialFolderDeleted: () => {
      deleteCallbackCalled = true
      return new Promise(() => {})
    },
  })
  const source = writeFile(path.join(
    fixture.runsDir,
    'run-local-edit',
    'raw',
    'shot_001',
    'source.mp4',
  ))
  const incomingFile = writeFile(path.join(fixture.dataRoot, 'incoming', 'added.mp4'), 'added-video')
  const incomingFolder = path.join(fixture.dataRoot, 'incoming-folder')
  writeFile(path.join(incomingFolder, 'nested', 'folder-added.mp4'), 'folder-added-video')

  const root = fixture.service.browseMaterials()
  const local = fixture.service.browseMaterials({ folderId: findFolder(root, '本地素材').id })
  const batch = findFolder(local, 'run-local-edit')
  const batchListing = fixture.service.browseMaterials({ folderId: batch.id })
  const shot = findFolder(batchListing, 'shot_001')
  assert.deepEqual({
    canCreate: shot.canCreate,
    canImport: shot.canImport,
    canRename: shot.canRename,
    canDelete: shot.canDelete,
    storageScope: shot.storageScope,
  }, {
    canCreate: true,
    canImport: true,
    canRename: true,
    canDelete: true,
    storageScope: 'downloads',
  })

  const child = fixture.service.createMaterialFolder({ parentFolderId: shot.id, name: '新建目录' })
  assert.equal(child.ok, true)
  assert.equal(fs.existsSync(path.join(path.dirname(source), '新建目录')), true)

  selectedPaths = [incomingFile]
  const importedFiles = await fixture.service.importMaterials(null, { folderId: shot.id, selection: 'files' })
  assert.equal(importedFiles.length, 1)
  assert.equal(fs.existsSync(path.join(path.dirname(source), 'added.mp4')), true)

  selectedPaths = [incomingFolder]
  const importedFolder = await fixture.service.importMaterials(null, { folderId: shot.id, selection: 'folder' })
  assert.equal(importedFolder.length, 1)
  assert.equal(
    fs.existsSync(path.join(path.dirname(source), 'incoming-folder', 'nested', 'folder-added.mp4')),
    true,
  )

  const renamed = await fixture.service.renameMaterialFolder({ folderId: shot.id, name: 'shot-renamed' })
  assert.equal(renamed.ok, true)
  const renamedDirectory = path.join(fixture.runsDir, 'run-local-edit', 'raw', 'shot-renamed')
  assert.equal(fs.existsSync(renamedDirectory), true)

  const destination = fixture.service.createMaterialFolder({ parentFolderId: batch.id, name: '归档' })
  assert.equal(destination.ok, true)
  const moved = fixture.service.moveMaterialFolder({
    folderId: renamed.folder.id,
    destinationFolderId: destination.folder.id,
  })
  assert.equal(moved.ok, true)
  const movedDirectory = path.join(fixture.runsDir, 'run-local-edit', 'raw', '归档', 'shot-renamed')
  assert.equal(fs.existsSync(movedDirectory), true)

  const startedAt = performance.now()
  const deleted = await fixture.service.deleteMaterialFolder({ folderId: moved.folder.id })
  const elapsed = performance.now() - startedAt
  assert.equal(deleted.ok, true)
  assert.equal(deleteCallbackCalled, true)
  assert.equal(elapsed < 1_000, true, `delete took ${elapsed.toFixed(1)}ms`)
  assert.equal(fs.existsSync(movedDirectory), false)
  const destinationListing = fixture.service.browseMaterials({ folderId: destination.folder.id })
  assert.equal(destinationListing.folders.some((folder) => folder.name === 'shot-renamed'), false)
})

test('dated task downloads are processed from direct files while hidden work files stay excluded', async (t) => {
  const queued = []
  const statuses = new Map()
  const identityStore = {
    getOrCreateFolder: () => 'fld_dated_downloads',
    describeKnownFile: (file) => ({
      ...file,
      materialId: `mat_${path.basename(file.path)}`,
      assetId: `asset_${path.basename(file.path)}`,
      assetVersion: 1,
      sourceSha256: 'c'.repeat(64),
      localStatus: 'present',
      analysisStatus: statuses.get(file.path) || 'pending',
      cloudStatus: 'not_uploaded',
    }),
    setAnalysisStatusForFile: (file, status) => { statuses.set(file, status) },
  }
  const fixture = createFixture(t, {
    identityStore,
    hasExistingAnalysis: async () => true,
    onDownloadedMaterials: (files) => { queued.push(...files) },
  })
  const taskDirectory = path.join(fixture.runsDir, '20260902', '纸飞机投放版')
  const runPath = path.join(
    fixture.runsDir,
    '.videoautocut',
    '20260902',
    '纸飞机投放版',
    'run_test_12345',
  )
  const source = writeFile(path.join(taskDirectory, 'pexels-source.mp4'))
  writeFile(path.join(taskDirectory, '_indexed_h264', '001_pexels-source.mp4'))
  writeFile(path.join(runPath, 'clips', 'generated-clip.mp4'))

  const result = await fixture.service.processDownloadedMaterials(runPath, {
    markIndexedReady: true,
    analyzeMissing: false,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.ready, 1)
  assert.equal(statuses.get(source), 'ready')
  assert.deepEqual(queued.map((file) => file.path), [source])
})

test('folder import preserves the selected root and every nested directory name', async (t) => {
  const events = []
  let dialogOptions
  const sourceRoot = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-folder-import-source-')),
    '客户项目',
  )
  t.after(() => fs.rmSync(path.dirname(sourceRoot), { recursive: true, force: true }))
  const first = writeFile(path.join(sourceRoot, '第一幕', '近景', 'camera-a.mp4'), 'camera-a')
  const second = writeFile(path.join(sourceRoot, '第二幕', 'camera-b.mov'), 'camera-b')
  writeFile(path.join(sourceRoot, '第二幕', 'notes.txt'), 'not-a-video')
  writeFile(path.join(sourceRoot, '.cache', 'hidden.mp4'), 'hidden-video')
  fs.mkdirSync(path.join(sourceRoot, '第三幕', '空镜头'), { recursive: true })

  const fixture = createFixture(t, {
    showOpenDialog: async (_window, options) => {
      dialogOptions = options
      return { canceled: false, filePaths: [sourceRoot] }
    },
    send: (_channel, event) => events.push(event),
  })
  const root = fixture.service.browseMaterials()
  const userNode = findFolder(root, '本地素材')
  const existingRoot = fixture.service.createMaterialFolder({
    parentFolderId: userNode.id,
    name: '客户项目',
  })
  assert.equal(existingRoot.ok, true)
  const existingFirstAct = fixture.service.createMaterialFolder({
    parentFolderId: existingRoot.folder.id,
    name: '第一幕',
  })
  assert.equal(existingFirstAct.ok, true)

  const imported = await fixture.service.importMaterials(null, { selection: 'folder' })

  assert.deepEqual(dialogOptions.properties, ['openDirectory'])
  assert.equal(imported.length, 2)
  assert.equal(
    fs.readFileSync(path.join(fixture.materialsDir, '客户项目', '第一幕', '近景', 'camera-a.mp4'), 'utf8'),
    fs.readFileSync(first, 'utf8'),
  )
  assert.equal(
    fs.readFileSync(path.join(fixture.materialsDir, '客户项目', '第二幕', 'camera-b.mov'), 'utf8'),
    fs.readFileSync(second, 'utf8'),
  )
  assert.equal(fs.existsSync(path.join(fixture.materialsDir, '客户项目', '第三幕', '空镜头')), true)
  assert.equal(fs.existsSync(path.join(fixture.materialsDir, '客户项目', '.cache')), false)
  assert.equal(
    fixture.service.browseMaterials({ folderId: userNode.id }).folders
      .filter((folder) => folder.name === '客户项目').length,
    1,
  )
  assert.equal(events.find((event) => event.type === 'import-started')?.totalFiles, 2)
  assert.equal(events.find((event) => event.type === 'import-completed')?.imported, 2)
})

test('canceling a staged import emits terminal state and removes its session files', async (t) => {
  const folderIds = new Map()
  const events = []
  let selectedPaths = []
  let service
  const identityStore = {
    getOrCreateFolder: ({ scope, storageKey }) => {
      const key = `${scope}:${storageKey}`
      if (!folderIds.has(key)) folderIds.set(key, `fld_test_${folderIds.size + 1}`)
      return folderIds.get(key)
    },
    importMaterialFileWithProgress: async (
      sourcePath,
      _destinationDirectory,
      _folderId,
      options,
    ) => {
      fs.mkdirSync(options.stagingDirectory, { recursive: true })
      fs.writeFileSync(path.join(options.stagingDirectory, 'partial-upload.mp4'), 'partial')
      options.onProgress({
        phase: 'copying',
        bytesProcessed: 4,
        totalBytes: fs.statSync(sourcePath).size,
      })
      await new Promise((resolve) => setImmediate(resolve))
      if (options.isCanceled()) throw new Error('素材导入已取消')
      throw new Error('测试未触发取消')
    },
  }
  const fixture = createFixture(t, {
    identityStore,
    showOpenDialog: async () => ({ canceled: false, filePaths: selectedPaths }),
    send: (_channel, event) => {
      events.push(event)
      if (event.type === 'import-progress') service.cancelMaterialImport()
    },
  })
  service = fixture.service
  selectedPaths = [writeFile(
    path.join(fixture.dataRoot, 'incoming', 'cancel-me.mp4'),
    'video-that-will-be-canceled',
  )]

  const imported = await service.importMaterials(null)

  assert.deepEqual(imported, [])
  assert.deepEqual(
    events.map((event) => event.type),
    ['import-started', 'import-progress', 'import-canceled'],
  )
  const sessionId = events[0].sessionId
  assert.equal(events.at(-1).sessionId, sessionId)
  assert.equal(fs.existsSync(path.join(fixture.materialsDir, '.staging', sessionId)), false)
  assert.equal(service.cancelMaterialImport().ok, false)
})

test('stopping material work waits for import cancellation cleanup before releasing its account', async (t) => {
  let selectedPaths = []
  let finishCopy
  let enteredCopy
  const copyEntered = new Promise(resolve => { enteredCopy = resolve })
  const copyReleased = new Promise(resolve => { finishCopy = resolve })
  const events = []
  const fixture = createFixture(t, {
    identityStore: {
      getOrCreateFolder: () => 'fld_local',
      importMaterialFileWithProgress: async (_source, _directory, _folder, options) => {
        fs.mkdirSync(options.stagingDirectory, { recursive: true })
        fs.writeFileSync(path.join(options.stagingDirectory, 'partial.mp4'), 'partial')
        enteredCopy()
        await copyReleased
        assert.equal(options.isCanceled(), true)
        throw new Error('素材导入已取消')
      },
    },
    showOpenDialog: async () => ({ canceled: false, filePaths: selectedPaths }),
    onMaterialsImported: () => assert.fail('closed account must not enqueue backup'),
    send: (_channel, event) => events.push(event),
  })
  selectedPaths = [writeFile(path.join(fixture.dataRoot, 'incoming', 'source.mp4'))]
  const importing = fixture.service.importMaterials(null)
  await copyEntered
  let stopped = false
  const stopping = fixture.service.stopMaterialWork().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  finishCopy()
  await stopping
  assert.deepEqual(await importing, [])
  assert.equal(events.at(-1).type, 'import-canceled')
  assert.equal(fs.existsSync(path.join(fixture.materialsDir, '.staging', events[0].sessionId)), false)
})

test('download folders reject create and targeted import before opening a file dialog', async (t) => {
  let dialogCalls = 0
  const fixture = createFixture(t, {
    showOpenDialog: async () => {
      dialogCalls += 1
      return { canceled: true, filePaths: [] }
    },
  })
  writeFile(path.join(fixture.runsDir, 'run-locked', 'raw', 'shot', 'source.mp4'))

  const root = fixture.service.browseMaterials()
  const downloads = fixture.service.browseMaterials({
    folderId: findFolder(root, '云端素材').id,
  })
  const batchNode = findFolder(downloads, 'run-locked')

  const created = fixture.service.createMaterialFolder({
    parentFolderId: batchNode.id,
    name: 'forbidden',
  })
  assert.equal(created.ok, false)
  assert.match(created.message || '', /不可新建子文件夹/)
  await assert.rejects(
    fixture.service.importMaterials(null, { folderId: batchNode.id }),
    /不可导入素材/,
  )
  assert.equal(dialogCalls, 0)
  assert.equal(fs.existsSync(path.join(fixture.runsDir, 'run-locked', 'raw', 'forbidden')), false)
})

test('material list recursively includes user uploads and raw originals only', (t) => {
  let runDirectory = ''
  const fixture = createFixture(t, {
    listRuns: () => [{
      id: 'run-list',
      projectName: '下载批次',
      path: runDirectory,
    }],
  })
  runDirectory = path.join(fixture.runsDir, 'run-list')

  writeFile(path.join(fixture.materialsDir, 'root-upload.mp4'))
  writeFile(path.join(fixture.materialsDir, 'project', 'nested-upload.webm'))
  writeFile(path.join(fixture.materialsDir, 'project', 'generated', 'nested-generated-name.mp4'))
  writeFile(path.join(fixture.materialsDir, 'project', 'cloud', 'ordinary-cloud-folder.mp4'))
  writeFile(path.join(fixture.materialsDir, 'cloud', 'asset_other_owner', '1', 'private-cloud-cache.mp4'))
  writeFile(path.join(fixture.materialsDir, 'generated', 'generated-output.mp4'))
  writeFile(path.join(fixture.materialsDir, 'project', '_indexed_h264', 'cached-user.mp4'))
  writeFile(path.join(runDirectory, 'raw', 'shot', 'raw-source.mp4'))
  writeFile(path.join(runDirectory, 'raw', 'shot', '_indexed_h264', 'cached-raw.mp4'))
  writeFile(path.join(runDirectory, 'clips', 'shot', 'clip.mp4'))
  writeFile(path.join(runDirectory, 'final_clips', 'final.mp4'))

  const library = fixture.service.list()
  assert.deepEqual(
    library.user
      .map((file) => path.relative(fixture.materialsDir, file.path))
      .sort(),
    [
      path.join('project', 'generated', 'nested-generated-name.mp4'),
      path.join('project', 'cloud', 'ordinary-cloud-folder.mp4'),
      path.join('project', 'nested-upload.webm'),
      'root-upload.mp4',
    ].sort(),
  )
  assert.equal(library.runs.length, 1)
  assert.deepEqual(
    library.runs[0].raw.map((file) => path.relative(runDirectory, file.path)),
    [path.join('raw', 'shot', 'raw-source.mp4')],
  )

  const serialized = JSON.stringify(library)
  assert.doesNotMatch(serialized, /private-cloud-cache|generated-output|cached-user|cached-raw|clip\.mp4|final\.mp4/)
})

test('semantic fallback excludes another account cloud cache and preserves the owned cloud folder identity', async (t) => {
  let store
  let sentryEntry = ''
  const fixture = createFixture(t, {
    createIdentityStore: options => {
      store = createMaterialLocalStore({
        ...options, databasePath: path.join(options.dataRoot, 'material-library.sqlite'),
        manifestsDir: path.join(options.dataRoot, 'manifests'),
      })
      return store
    },
    getSentrySearchPaths: () => ({
      exe: path.join(fixture.dataRoot, 'missing-sentry.exe'), python: process.execPath, entry: sentryEntry,
    }),
    isRuntimeUsable: () => true,
  })
  const localFile = writeFile(path.join(fixture.materialsDir, 'project', 'same.mp4'))
  const otherAccount = writeFile(path.join(fixture.materialsDir, 'cloud', 'asset_other', '1', 'same.mp4'))
  const content = Buffer.from('owned cloud original')
  const sourceSha256 = createHash('sha256').update(content).digest('hex')
  store.upsertCloudFolder({ folderId: 'fld_owned', name: '纱桶上下料', revision: 1 })
  store.upsertCloudMaterial({
    materialId: 'mat_owned', assetId: 'asset_owned', assetVersion: 1, folderId: 'fld_owned',
    displayName: 'same.mp4', origin: 'user_upload', addedFrom: 'cloud_restore', sourceSha256,
    sourceSize: content.length, mimeType: 'video/mp4', analysisStatus: 'ready', cloudStatus: 'ready', revision: 1,
  })
  const before = store.getMaterialCloudFileById('mat_owned')
  const ownedFile = writeFile(before.localPath, content)
  store.completeCloudDownload('mat_owned', ownedFile, sourceSha256, content.length)
  sentryEntry = writeFile(path.join(fixture.dataRoot, 'fake-sentry.mjs'), [
    `console.log(${JSON.stringify(`#1 [0.99] ${otherAccount}`)})`,
    `console.log(${JSON.stringify(`#2 [0.98] ${ownedFile}`)})`,
    `console.log(${JSON.stringify(`#3 [0.97] ${localFile}`)})`,
    ...(process.platform === 'win32'
      ? [`console.log(${JSON.stringify(`#4 [0.96] ${path.toNamespacedPath(otherAccount)}`)})`] : []),
  ].join('\n'))
  const result = await fixture.service.semanticSearch('纱桶上下料')
  assert.equal(result.ok, true)
  assert.deepEqual(result.results.map(file => file.localPath), [ownedFile, localFile])
  assert.equal(result.results[0].materialId, 'mat_owned')
  assert.equal(store.getMaterialCloudFileByPath(otherAccount), null)
  const after = store.getMaterialCloudFileById('mat_owned')
  assert.equal(after.localFolderId, before.localFolderId)
  assert.equal(after.cloudFolderId, before.cloudFolderId)
  assert.equal(after.folderId, before.folderId)
  assert.deepEqual(store.folderChainForMaterial('mat_owned').map(folder => folder.name), ['纱桶上下料'])
})

test('semantic result enrichment searches user uploads and raw originals but not generated or task outputs', async (t) => {
  let runDirectory = ''
  let sentryEntry = ''
  const fixture = createFixture(t, {
    getSentrySearchPaths: () => ({
      exe: path.join(fixture.dataRoot, 'missing-sentry.exe'),
      python: process.execPath,
      entry: sentryEntry,
    }),
    isRuntimeUsable: () => true,
    listRuns: () => [{
      id: 'run-search',
      projectName: '搜索批次',
      path: runDirectory,
    }],
  })
  runDirectory = path.join(fixture.runsDir, 'run-search')

  const userFile = writeFile(path.join(fixture.materialsDir, 'user', 'semantic-user.mp4'))
  const rawFile = writeFile(path.join(runDirectory, 'raw', 'shot', 'semantic-raw.mp4'))
  const generatedFile = writeFile(path.join(
    fixture.materialsDir,
    'generated',
    'semantic-generated.mp4',
  ))
  const clipFile = writeFile(path.join(runDirectory, 'clips', 'semantic-clip.mp4'))
  sentryEntry = path.join(fixture.dataRoot, 'fake-sentry.mjs')
  writeFile(sentryEntry, [
    `console.log(${JSON.stringify(`#1 [0.99] ${userFile}`)})`,
    `console.log(${JSON.stringify(`#2 [0.98] ${rawFile}`)})`,
    `console.log(${JSON.stringify(`#3 [0.97] ${generatedFile}`)})`,
    `console.log(${JSON.stringify(`#4 [0.96] ${clipFile}`)})`,
  ].join('\n'))

  const response = await fixture.service.semanticSearch('语义素材')
  assert.equal(response.ok, true)
  assert.deepEqual(
    response.results.map((item) => item.localPath || ''),
    [userFile, rawFile, '', ''],
  )
  assert.match(response.results[0].localUrl || '', /^videoauto-media:/)
  assert.match(response.results[1].localUrl || '', /^videoauto-media:/)
})

test('automatic creation reuses an available cloud search match before starting the generator', async (t) => {
  let matchedPath = ''
  let cloudQueries = []
  const fixture = createFixture(t, {
    cloudSemanticSearch: async (query) => {
      cloudQueries.push(query)
      return {
        ok: true,
        results: [{
          rank: 1,
          score: 0.91,
          name: '工业机械臂.mp4',
          path: matchedPath,
          localPath: matchedPath,
          materialId: 'mat_robot',
          localStatus: 'present',
          analysisStatus: 'ready',
          cloudStatus: 'ready',
        }],
      }
    },
  })
  matchedPath = writeFile(path.join(fixture.materialsDir, '工业机械臂.mp4'))

  const generated = await fixture.service.generate({ prompt: '工业机械臂装配线动画' })

  assert.equal(generated.ok, true)
  assert.equal(generated.mode, 'reused')
  assert.equal(generated.reuse.materialId, 'mat_robot')
  assert.deepEqual(cloudQueries, ['工业机械臂装配线动画'])
})

test('automatic shot resolution downloads a cloud vector match when the local index is unavailable', async (t) => {
  let cloudQueries = 0
  let downloads = 0
  const known = { materialId: 'mat_cloud', localStatus: 'missing', localPath: '', cloudStatus: 'ready' }
  const fixture = createFixture(t, {
    identityStore: { getOrCreateFolder: () => 'fld_cloud', getMaterialCloudFileById: () => known },
    cloudSemanticSearch: async () => {
      cloudQueries += 1
      return { ok: true, results: [{ rank: 1, score: 0.88, name: 'cloud.mp4', materialId: 'mat_cloud', localStatus: 'missing', analysisStatus: 'ready', cloudStatus: 'ready' }] }
    },
    ensureCloudMaterialAvailable: async () => {
      downloads += 1
      known.localPath = writeFile(path.join(fixture.materialsDir, 'cloud.mp4'))
      known.localStatus = 'present'
      return { ok: true }
    },
  })
  const resolved = await fixture.service.autoResolveShotMaterials({ shots: [{ shot_id: 'shot_cloud', visual_query: '工业园区航拍', download_material: true }] })
  assert.equal(cloudQueries, 1)
  assert.equal(downloads, 1)
  assert.equal(resolved.matched, 1)
  assert.equal(resolved.fallback, 0)
  assert.equal(resolved.shots[0].download_material, false)
  assert.deepEqual(resolved.shots[0].material_bindings, [{ binding_type: 'material', material_id: 'mat_cloud' }])
})

test('automatic cloud reuse falls back if downloading the matched material fails', async (t) => {
  const fixture = createFixture(t, {
    cloudSemanticSearch: async () => ({ ok: true, results: [{ materialId: 'mat_cloud', score: 0.9, cloudStatus: 'ready', localStatus: 'missing' }] }),
    ensureCloudMaterialAvailable: async () => ({ ok: false, message: '下载失败' }),
  })
  const result = await fixture.service.autoResolveShotMaterials({ shots: [{ shot_id: 'shot_cloud', visual_query: 'factory' }] })
  assert.equal(result.matched, 0)
  assert.equal(result.fallback, 1)
  assert.equal(result.shots[0].material_resolution.message, '下载失败')
})

test('cloud vector match with an existing video restores the missing local index before binding', async (t) => {
  const known = { materialId: 'mat_cloud', localStatus: 'present', localPath: '', cloudStatus: 'ready', cloudAnalysisStatus: 'ready', analysisStatus: 'pending' }
  let restores = 0
  const fixture = createFixture(t, {
    identityStore: { getOrCreateFolder: () => 'fld_cloud', getMaterialCloudFileById: () => known },
    cloudSemanticSearch: async () => ({ ok: true, results: [{ materialId: known.materialId, score: 0.9, cloudStatus: 'ready', analysisStatus: 'ready' }] }),
    ensureCloudMaterialAvailable: async () => { restores++; known.analysisStatus = 'ready'; return { ok: true } },
  })
  known.localPath = writeFile(path.join(fixture.materialsDir, 'cloud.mp4'))
  const resolved = await fixture.service.autoResolveShotMaterials({ shots: [{ shot_id: 'cloud', visual_query: 'factory' }] })
  assert.equal(restores, 1)
  assert.equal(resolved.matched, 1)
})

test('disabled local priority does not even start the local search runtime', async (t) => {
  let runtimeChecks = 0
  let cloudQueries = 0
  const fixture = createFixture(t, {
    isRuntimeUsable: () => { runtimeChecks += 1; return true },
    cloudSemanticSearch: async () => { cloudQueries += 1; return { ok: true, results: [] } },
  })
  const result = await fixture.service.autoResolveShotMaterials({
    preferLocalMaterials: false,
    shots: [{ shot_id: 'direct', title: 'robot', download_material: true }],
  })
  assert.equal(runtimeChecks, 0)
  assert.equal(cloudQueries, 0)
  assert.equal(result.fallback, 1)
  assert.equal(result.shots[0].download_material, true)
})

test('local priority binds an existing local search result without contacting the cloud library', async (t) => {
  let sentryEntry = ''
  let cloudQueries = 0
  const fixture = createFixture(t, {
    getSentrySearchPaths: () => ({
      exe: path.join(fixture.dataRoot, 'missing-sentry.exe'),
      python: process.execPath,
      entry: sentryEntry,
    }),
    isRuntimeUsable: () => true,
    identityStore: {
      getOrCreateFolder: ({ scope, storageKey }) => `${scope}:${storageKey}`,
      describeKnownFile: (file) => ({
        ...file, materialId: 'mat_local', localStatus: 'present', analysisStatus: 'ready',
      }),
    },
    cloudSemanticSearch: async () => { cloudQueries += 1; throw new Error('must not query cloud library') },
  })
  const localFile = writeFile(path.join(fixture.materialsDir, 'local-robot.mp4'))
  sentryEntry = path.join(fixture.dataRoot, 'fake-local-sentry.mjs')
  writeFile(sentryEntry, `console.log(${JSON.stringify(`#1 [0.9] ${localFile}`)})`)
  const result = await fixture.service.autoResolveShotMaterials({
    preferLocalMaterials: true,
    shots: [{ shot_id: 'local', title: 'robot', download_material: true }],
  })
  assert.equal(cloudQueries, 0)
  assert.equal(result.matched, 1)
  assert.equal(result.shots[0].download_material, false)
  assert.equal(result.shots[0].material_bindings[0].material_id, 'mat_local')
})
