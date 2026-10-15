import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createMaterialDirectoryBrowser } from '../dist-electron/material-directory.js'

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-material-directory-'))
  const materialsDir = path.join(root, 'video', 'materials')
  const runsDir = path.join(root, 'video', 'runs')
  fs.mkdirSync(materialsDir, { recursive: true })
  fs.mkdirSync(runsDir, { recursive: true })

  t.after(() => {
    const resolvedRoot = path.resolve(root)
    const resolvedSystemTemp = path.resolve(os.tmpdir())
    assert.equal(resolvedRoot.startsWith(`${resolvedSystemTemp}${path.sep}`), true)
    fs.rmSync(resolvedRoot, { recursive: true, force: true })
  })

  return { root, materialsDir, runsDir }
}

function writeVideo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'test-video', 'utf8')
}

test('a browse shares directory reads but the next browse sees new files', (t) => {
  const workspace = createWorkspace(t)
  const folder = path.join(workspace.materialsDir, '测试')
  writeVideo(path.join(folder, 'one.mp4'))
  const browser = createMaterialDirectoryBrowser(workspace)
  const original = fs.readdirSync
  let scans = 0
  t.mock.method(fs, 'readdirSync', function (target, ...args) {
    if (path.resolve(String(target)) === path.resolve(folder)) scans++
    return original.call(fs, target, ...args)
  })
  const first = browser.browseMaterials()
  assert.equal(scans, 1)
  writeVideo(path.join(folder, 'two.mp4'))
  const second = browser.browseMaterials()
  assert.equal(scans, 2)
  assert.equal(second.root.videoCount, first.root.videoCount + 1)
})

function directoryStoreFixture(account = 'account-A') {
  const identities = new Map()
  const identityKeys = new Map()
  const cloudFiles = []
  const calls = { folders: 0, cloudFiles: 0 }
  let revision = 0
  return {
    identities, identityKeys, cloudFiles, calls,
    change() { revision++ },
    getMaterialReadRevision: () => `${account}:${revision}`,
    withMaterialReadSnapshot: read => read(),
    getOrCreateFolder(input) {
      const key = `${input.scope}:${input.storageKey}`
      if (identityKeys.has(key)) return identityKeys.get(key)
      const folderId = `fld_${account}_${identityKeys.size}`
      identityKeys.set(key, folderId)
      identities.set(folderId, { ...input, folderId, revision: 1, cloudRevision: 0 })
      revision++
      return folderId
    },
    getFolder: id => identities.get(id) || null,
    listFolders(scope) { calls.folders++; return [...identities.values()].filter(folder => folder.scope === scope) },
    listFolderFiles: () => [],
    listCloudFiles() { calls.cloudFiles++; return [...cloudFiles] },
    isFolderStorageDeleted: () => false,
    describeFile: file => ({ ...file, assetId: file.path, assetVersion: 1, localStatus: 'present', cloudStatus: 'not_uploaded' }),
  }
}

test('browse reads each physical directory and complete cloud folder table only once per request', t => {
  const workspace = createWorkspace(t)
  writeVideo(path.join(workspace.materialsDir, 'scara', 'nested', 'local.mp4'))
  writeVideo(path.join(workspace.runsDir, '20260916', 'task', 'raw', 'shot', 'download.mp4'))
  const identityStore = directoryStoreFixture()
  const browser = createMaterialDirectoryBrowser({ ...workspace, identityStore })
  const scans = new Map()
  const readdir = fs.readdirSync
  t.mock.method(fs, 'readdirSync', function (target, ...args) {
    const key = path.resolve(String(target))
    scans.set(key, (scans.get(key) || 0) + 1)
    return readdir.call(fs, target, ...args)
  })
  const result = browser.browseMaterials()
  assert.equal(result.root.videoCount, 2)
  assert.ok(scans.size >= 6)
  assert.equal(Math.max(...scans.values()), 1)
  assert.equal(identityStore.calls.folders, 1)
  assert.equal(identityStore.calls.cloudFiles, 1)
})

test('small-folder navigation reuses root counts and invalidates for filesystem or database changes', t => {
  const workspace = createWorkspace(t)
  const selected = path.join(workspace.materialsDir, 'scara')
  const unrelated = path.join(workspace.materialsDir, 'other', 'nested')
  writeVideo(path.join(selected, 'one.mp4'))
  writeVideo(path.join(unrelated, 'two.mp4'))
  const identityStore = directoryStoreFixture()
  const browser = createMaterialDirectoryBrowser({ ...workspace, identityStore })
  const initial = browser.browseMaterials()
  const selectedId = identityStore.identityKeys.get('user:scara')
  const scans = []
  const readdir = fs.readdirSync
  t.mock.method(fs, 'readdirSync', function (target, ...args) {
    scans.push(path.resolve(String(target)))
    return readdir.call(fs, target, ...args)
  })
  const warm = browser.browseMaterials({ folderId: selectedId })
  assert.equal(warm.root.videoCount, initial.root.videoCount)
  assert.deepEqual(scans, [selected])

  const added = path.join(unrelated, 'new.mp4')
  writeVideo(added)
  scans.length = 0
  const imported = browser.browseMaterials({ folderId: selectedId })
  assert.equal(imported.root.videoCount, initial.root.videoCount + 1)
  assert.ok(scans.includes(unrelated))
  fs.unlinkSync(added)
  const removed = browser.browseMaterials({ folderId: selectedId })
  assert.equal(removed.root.videoCount, initial.root.videoCount)

  identityStore.cloudFiles.push({ name: 'cloud.mp4', path: path.join(workspace.root, 'missing.mp4'), size: 1, mtime: 1,
    assetId: 'cloud-asset', assetVersion: 1, cloudStatus: 'ready', localStatus: 'missing' })
  identityStore.change()
  const synced = browser.browseMaterials({ folderId: selectedId })
  assert.equal(synced.root.videoCount, initial.root.videoCount + 1)
  assert.equal(synced.rootFolders.find(folder => folder.name === '云端素材').videoCount, 1)
  const cloudCache = path.join(workspace.materialsDir, 'cloud', 'owned', 'cloud.mp4')
  writeVideo(cloudCache)
  identityStore.cloudFiles[0].path = cloudCache
  identityStore.cloudFiles[0].localStatus = 'present'
  identityStore.change()
  const downloaded = browser.browseMaterials({ folderId: selectedId })
  assert.equal(downloaded.rootFolders.find(folder => folder.name === '本地素材').videoCount, initial.root.videoCount + 1)
  fs.unlinkSync(cloudCache)
  const evicted = browser.browseMaterials({ folderId: selectedId })
  assert.equal(evicted.rootFolders.find(folder => folder.name === '本地素材').videoCount, initial.root.videoCount)
  const otherAccount = createMaterialDirectoryBrowser({ ...workspace, identityStore: directoryStoreFixture('account-B') })
  assert.equal(otherAccount.browseMaterials().root.videoCount, initial.root.videoCount)
})

test('selection scope limits fail explicitly instead of returning a truncated candidate count', (t) => {
  const workspace = createWorkspace(t)
  const selectedDirectory = path.join(workspace.materialsDir, 'scara')
  fs.mkdirSync(selectedDirectory)
  const identities = new Map()
  const identityKeys = new Map()
  let summarized = false
  const identityStore = {
    getOrCreateFolder(input) {
      const key = `${input.scope}:${input.storageKey}`
      if (identityKeys.has(key)) return identityKeys.get(key)
      const folderId = `fld_${identityKeys.size}`
      identityKeys.set(key, folderId)
      identities.set(folderId, { ...input, folderId, revision: 1, cloudRevision: 0 })
      return folderId
    },
    getFolder: (id) => identities.get(id) || null,
    listFolderFiles: () => [],
    summarizeMaterialSelection() {
      summarized = true
      return { candidateCount: 0, entries: [] }
    },
  }
  const browser = createMaterialDirectoryBrowser({ ...workspace, identityStore })
  const selectedId = identityStore.getOrCreateFolder({ scope: 'user', storageKey: 'scara', name: 'scara' })
  const readdir = fs.readdirSync
  const lstat = fs.lstatSync
  const realpath = fs.realpathSync
  const isVirtualChild = (target) => path.dirname(String(target)) === selectedDirectory
  const virtualEntries = Array.from({ length: 10_001 }, (_, index) => ({
    name: `virtual-${index}`, isDirectory: () => true, isSymbolicLink: () => false,
  }))
  t.mock.method(fs, 'readdirSync', function (target, ...args) {
    if (String(target) === selectedDirectory) return virtualEntries
    if (isVirtualChild(target)) return []
    return readdir.call(fs, target, ...args)
  })
  t.mock.method(fs, 'lstatSync', function (target, ...args) {
    if (isVirtualChild(target)) return { isDirectory: () => true, isSymbolicLink: () => false }
    return lstat.call(fs, target, ...args)
  })
  t.mock.method(fs, 'realpathSync', function (target, ...args) {
    if (isVirtualChild(target)) return String(target)
    return realpath.call(fs, target, ...args)
  })
  assert.throws(() => browser.summarizeMaterialSelection({ bindings: [
    { binding_type: 'folder', folder_id: selectedId, include_subfolders: true },
  ] }), /超过 10000 个文件夹/)
  assert.equal(summarized, false)
})

function findFolder(listing, name) {
  const folder = listing.folders.find((item) => item.name === name)
  assert.ok(folder, `missing folder: ${name}`)
  return folder
}

function assertCapabilities(node, expected) {
  assert.deepEqual(
    {
      canCreate: node.canCreate,
      canRename: node.canRename,
      canDelete: node.canDelete,
    },
    expected,
    node.name,
  )
}

function assertNoFolderPaths(value) {
  for (const key of ['current', 'folder']) {
    if (value[key]) assert.equal(Object.hasOwn(value[key], 'path'), false)
  }
  for (const item of value.folders || []) assert.equal(Object.hasOwn(item, 'path'), false)
  for (const item of value.rootFolders || []) assert.equal(Object.hasOwn(item, 'path'), false)
  for (const item of value.breadcrumbs || []) assert.deepEqual(Object.keys(item).sort(), ['id', 'name'])
}

test('local root includes every locally available material while cloud keeps downloaded originals', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  writeVideo(path.join(materialsDir, 'root-upload.mp4'))
  writeVideo(path.join(materialsDir, 'user-folder', 'nested-upload.mp4'))
  writeVideo(path.join(materialsDir, 'generated', 'generated-output.mp4'))
  writeVideo(path.join(materialsDir, '_indexed_h264', 'cache.mp4'))

  writeVideo(path.join(runsDir, 'run-02', 'raw', 'direct.mp4'))
  writeVideo(path.join(runsDir, 'run-02', 'raw', 'shot_001', 'candidate.mp4'))
  writeVideo(path.join(runsDir, 'run-02', 'clips', 'shot_001', 'clip.mp4'))
  writeVideo(path.join(runsDir, 'run-02', 'final_clips', 'final.mp4'))
  fs.mkdirSync(path.join(runsDir, 'run-empty-raw', 'raw'), { recursive: true })
  writeVideo(path.join(runsDir, 'run-without-raw', 'clips', 'clip.mp4'))

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  assert.equal(root.current.name, '素材库')
  assert.deepEqual(root.folders.map(({ name }) => name), ['本地素材', '云端素材'])
  assert.deepEqual(root.rootFolders.map(({ name }) => name), ['本地素材', '云端素材'])
  assert.deepEqual(root.breadcrumbs.map(({ name }) => name), ['素材库'])
  assert.deepEqual(
    root.files.map(({ name }) => name).sort(),
    ['candidate.mp4', 'direct.mp4', 'nested-upload.mp4', 'root-upload.mp4'],
  )
  assert.equal(root.current.videoCount, 4)
  assert.deepEqual(root.rootFolders.map(({ videoCount }) => videoCount), [4, 2])
  assertCapabilities(root.current, { canCreate: false, canRename: false, canDelete: false })
  assertNoFolderPaths(root)

  const userNode = findFolder(root, '本地素材')
  assertCapabilities(userNode, { canCreate: true, canRename: false, canDelete: false })
  const user = browser.browseMaterials({ folderId: userNode.id })
  assert.deepEqual(
    user.files.map(({ name }) => name).sort(),
    ['candidate.mp4', 'direct.mp4', 'nested-upload.mp4', 'root-upload.mp4'],
  )
  assert.deepEqual(user.folders.map(({ name }) => name), ['run-02', 'user-folder'])
  assert.equal(user.folders.some(({ name }) => name === 'generated'), false)
  assert.equal(user.folders.some(({ name }) => name === '_indexed_h264'), false)
  const localBatchNode = findFolder(user, 'run-02')
  const localUserFolderNode = findFolder(user, 'user-folder')
  assertCapabilities(localBatchNode, { canCreate: true, canRename: true, canDelete: true })
  assertCapabilities(localUserFolderNode, { canCreate: true, canRename: true, canDelete: true })

  const localBatch = browser.browseMaterials({ folderId: localBatchNode.id })
  assert.deepEqual(
    localBatch.breadcrumbs.map(({ name }) => name),
    ['素材库', '本地素材', 'run-02'],
  )
  assert.deepEqual(localBatch.folders.map(({ name }) => name), ['shot_001'])
  assert.deepEqual(localBatch.files.map(({ name }) => name), ['direct.mp4'])

  const localShotNode = findFolder(localBatch, 'shot_001')
  assertCapabilities(localShotNode, { canCreate: true, canRename: true, canDelete: true })
  const localShot = browser.browseMaterials({ folderId: localShotNode.id })
  assert.deepEqual(localShot.files.map(({ name }) => name), ['candidate.mp4'])

  const downloadsNode = findFolder(root, '云端素材')
  assertCapabilities(downloadsNode, { canCreate: false, canRename: false, canDelete: false })
  const downloads = browser.browseMaterials({ folderId: downloadsNode.id })
  assert.deepEqual(downloads.folders.map(({ name }) => name), ['run-02'])
  assert.notEqual(findFolder(downloads, 'run-02').id, localBatchNode.id)
  assert.deepEqual(downloads.files.map(({ name }) => name).sort(), ['candidate.mp4', 'direct.mp4'])
  assert.equal(downloads.current.videoCount, 2)
  assert.equal(downloads.folders.some(({ name }) => name === 'run-empty-raw'), false)
  assert.equal(downloads.folders.some(({ name }) => name === 'run-without-raw'), false)

  const batch = browser.browseMaterials({ folderId: findFolder(downloads, 'run-02').id })
  assert.deepEqual(batch.breadcrumbs.map(({ name }) => name), ['素材库', '云端素材', 'run-02'])
  assert.deepEqual(batch.folders.map(({ name }) => name), ['shot_001'])
  assert.deepEqual(batch.files.map(({ name }) => name), ['direct.mp4'])
  assertCapabilities(batch.current, { canCreate: false, canRename: false, canDelete: false })

  const shot = browser.browseMaterials({ folderId: findFolder(batch, 'shot_001').id })
  assert.deepEqual(shot.files.map(({ name }) => name), ['candidate.mp4'])
  assertCapabilities(shot.current, { canCreate: false, canRename: false, canDelete: false })
})

test('browse and search hide generated, indexed, clips, and final task output', async (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  writeVideo(path.join(materialsDir, 'user-topic', 'user.mp4'))
  writeVideo(path.join(materialsDir, 'generated', 'generated-topic', 'generated.mp4'))
  writeVideo(path.join(materialsDir, 'user-topic', '_indexed_h264', 'cache.mp4'))

  const runDirectory = path.join(runsDir, 'batch-topic')
  writeVideo(path.join(runDirectory, 'raw', 'shot-topic', 'source.mp4'))
  writeVideo(path.join(runDirectory, 'raw', 'shot-topic', '_indexed_h264', 'cached.mp4'))
  writeVideo(path.join(runDirectory, 'clips', 'clip-topic', 'clip.mp4'))
  writeVideo(path.join(runDirectory, 'final_clips', 'final-topic.mp4'))

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const user = browser.browseMaterials({ folderId: findFolder(root, '本地素材').id })
  const downloads = browser.browseMaterials({ folderId: findFolder(root, '云端素材').id })
  const batch = browser.browseMaterials({ folderId: findFolder(downloads, 'batch-topic').id })
  const shot = browser.browseMaterials({ folderId: findFolder(batch, 'shot-topic').id })

  assert.deepEqual(user.folders.map(({ name }) => name), ['batch-topic', 'user-topic'])
  assert.deepEqual(shot.folders, [])
  assert.deepEqual(shot.files.map(({ name }) => name), ['source.mp4'])
  assert.deepEqual(await browser.searchMaterialFolders({ query: 'generated-topic' }), [])
  assert.deepEqual(await browser.searchMaterialFolders({ query: '_indexed_h264' }), [])
  assert.deepEqual(await browser.searchMaterialFolders({ query: 'clip-topic' }), [])
  assert.deepEqual(await browser.searchMaterialFolders({ query: 'final-topic' }), [])

  const topicResults = await browser.searchMaterialFolders({ query: 'topic' })
  assert.deepEqual(
    topicResults.map(({ folder }) => folder.name),
    ['user-topic', 'batch-topic', 'shot-topic'],
  )
  topicResults.forEach(assertNoFolderPaths)
})

test('project material layout exposes date, project, storyboard and final-video folders', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  const taskDirectory = path.join(runsDir, '20260902', '纸飞机投放版')
  const storyboardDirectory = path.join(taskDirectory, '分镜视频')
  writeVideo(path.join(storyboardDirectory, '01 · 痛点引入', 'pexels-101.mp4'))
  writeVideo(path.join(storyboardDirectory, '02 · 方案概述', 'pexels-102.mov'))
  writeVideo(path.join(
    storyboardDirectory,
    '01 · 痛点引入',
    '_indexed_h264',
    '001_pexels-101.mp4',
  ))
  writeVideo(path.join(taskDirectory, '纸飞机投放版最终视频', '纸飞机投放版_v001.mp4'))
  writeVideo(path.join(
    taskDirectory,
    '.videoautocut',
    'runs',
    'run_test',
    'clips',
    'clip.mp4',
  ))

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const local = browser.browseMaterials({ folderId: findFolder(root, '本地素材').id })
  const cloud = browser.browseMaterials({ folderId: findFolder(root, '云端素材').id })
  const localDate = findFolder(local, '20260902')
  const cloudDate = findFolder(cloud, '20260902')
  assert.notEqual(localDate.id, cloudDate.id)
  assert.equal(localDate.videoCount, 3)
  assert.equal(cloudDate.videoCount, 3)

  const localDateContents = browser.browseMaterials({ folderId: localDate.id })
  assert.equal(localDateContents.current.videoCount, 3)
  const localTask = browser.browseMaterials({
    folderId: findFolder(localDateContents, '纸飞机投放版').id,
  })
  assert.deepEqual(localTask.files, [])
  assert.deepEqual(localTask.folders.map(({ name }) => name), [
    '分镜视频',
    '纸飞机投放版最终视频',
  ])
  assert.equal(localTask.current.videoCount, 3)
  assert.deepEqual(
    localTask.breadcrumbs.map(({ name }) => name),
    ['素材库', '本地素材', '20260902', '纸飞机投放版'],
  )

  const storyboard = browser.browseMaterials({
    folderId: findFolder(localTask, '分镜视频').id,
  })
  assert.deepEqual(storyboard.files, [])
  assert.deepEqual(storyboard.folders.map(({ name }) => name), [
    '01 · 痛点引入',
    '02 · 方案概述',
  ])
  assert.equal(storyboard.current.videoCount, 2)

  const firstShot = browser.browseMaterials({
    folderId: findFolder(storyboard, '01 · 痛点引入').id,
  })
  assert.deepEqual(firstShot.files.map(({ name }) => name), ['pexels-101.mp4'])

  const cloudDateContents = browser.browseMaterials({ folderId: cloudDate.id })
  const cloudTask = browser.browseMaterials({
    folderId: findFolder(cloudDateContents, '纸飞机投放版').id,
  })
  assert.deepEqual(cloudTask.folders.map(({ name }) => name), [
    '分镜视频',
    '纸飞机投放版最终视频',
  ])
})

test('creates user folders at the user root or a writable user child', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  writeVideo(path.join(runsDir, 'download-batch', 'raw', 'shot_001', 'source.mp4'))
  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const userNode = findFolder(root, '本地素材')
  const downloadsNode = findFolder(root, '云端素材')
  const downloads = browser.browseMaterials({ folderId: downloadsNode.id })
  const batchNode = findFolder(downloads, 'download-batch')

  const project = browser.createMaterialFolder(userNode.id, 'project.v2')
  assert.equal(project.name, 'project.v2')
  assert.equal(project.folderCount, 0)
  assert.equal(project.videoCount, 0)
  assertCapabilities(project, { canCreate: true, canRename: true, canDelete: true })
  assert.equal(fs.statSync(path.join(materialsDir, 'project.v2')).isDirectory(), true)

  const nested = browser.createMaterialFolder(project.id, 'nested')
  assert.equal(nested.name, 'nested')
  assert.deepEqual(
    browser.browseMaterials({ folderId: nested.id }).breadcrumbs.map(({ name }) => name),
    ['素材库', '本地素材', 'project.v2', 'nested'],
  )

  const defaultParent = browser.createMaterialFolder(undefined, 'default-parent')
  assert.equal(path.dirname(browser.getMaterialImportDirectory(defaultParent.id)), fs.realpathSync(materialsDir))
  assert.equal(browser.getMaterialImportDirectory(), fs.realpathSync(materialsDir))
  assert.equal(browser.getMaterialImportDirectory(userNode.id), fs.realpathSync(materialsDir))
  assert.equal(browser.getMaterialImportDirectory(nested.id), fs.realpathSync(path.join(materialsDir, 'project.v2', 'nested')))

  for (const protectedNode of [root.current, downloadsNode, batchNode]) {
    assert.throws(
      () => browser.createMaterialFolder(protectedNode.id, 'forbidden'),
      /不可新建子文件夹/,
    )
    assert.throws(
      () => browser.getMaterialImportDirectory(protectedNode.id),
      /不可导入素材/,
    )
  }
  assert.throws(() => browser.createMaterialFolder(userNode.id, 'generated'), /受保护/)
  assert.throws(() => browser.createMaterialFolder(userNode.id, '_indexed_h264'), /受保护/)
  assert.throws(() => browser.createMaterialFolder(userNode.id, 'project.v2'), /同名/)
  assert.throws(() => browser.createMaterialFolder(userNode.id, '../escaped'), /文件夹名称/)
  assert.throws(() => browser.getMaterialImportDirectory('unknown'), /无效/)
})

test('prepares, renames, and deletes only writable user folders', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  const sourceDirectory = path.join(materialsDir, 'project-before')
  const directVideo = path.join(sourceDirectory, 'direct.mp4')
  const nestedVideo = path.join(sourceDirectory, 'child', 'nested.webm')
  writeVideo(directVideo)
  writeVideo(nestedVideo)
  writeVideo(path.join(sourceDirectory, '_indexed_h264', 'cache.mp4'))
  writeVideo(path.join(runsDir, 'download-batch', 'raw', 'shot_001', 'source.mp4'))

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const userNode = findFolder(root, '本地素材')
  const user = browser.browseMaterials({ folderId: userNode.id })
  const sourceNode = findFolder(user, 'project-before')
  const source = browser.browseMaterials({ folderId: sourceNode.id })
  const childNode = findFolder(source, 'child')

  const prepared = browser.prepareFolderOperation(sourceNode.id)
  assert.deepEqual(prepared.videoPaths, [
    fs.realpathSync(directVideo),
    fs.realpathSync(nestedVideo),
  ].sort((first, second) => first.localeCompare(second, 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  })))

  const renamed = browser.renameMaterialFolder(sourceNode.id, 'project-after')
  const destinationDirectory = path.join(materialsDir, 'project-after')
  assert.equal(renamed.changed, true)
  assert.equal(renamed.folder.name, 'project-after')
  assertCapabilities(renamed.folder, { canCreate: true, canRename: true, canDelete: true })
  assert.equal(fs.existsSync(sourceDirectory), false)
  assert.equal(fs.existsSync(path.join(destinationDirectory, 'child', 'nested.webm')), true)
  assert.throws(() => browser.getMaterialFolderDetails(sourceNode.id), /无效/)
  assert.throws(() => browser.getMaterialFolderDetails(childNode.id), /无效/)

  const deleted = browser.deleteMaterialFolder(renamed.folder.id)
  assert.equal(deleted.folderId, renamed.folder.id)
  assert.equal(deleted.parentId, userNode.id)
  assert.equal(fs.existsSync(destinationDirectory), false)

  const downloads = browser.browseMaterials({ folderId: findFolder(root, '云端素材').id })
  const batch = findFolder(downloads, 'download-batch')
  for (const protectedNode of [root.current, userNode]) {
    assert.throws(() => browser.prepareFolderOperation(protectedNode.id), /不可重命名或删除/)
    assert.throws(() => browser.renameMaterialFolder(protectedNode.id, 'renamed'), /不可重命名或删除/)
    assert.throws(() => browser.deleteMaterialFolder(protectedNode.id), /不可重命名或删除/)
  }
})

test('moves user materials and folders only after collision and cycle validation', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  const sourceDirectory = path.join(materialsDir, 'source')
  const destinationDirectory = path.join(materialsDir, 'destination')
  writeVideo(path.join(sourceDirectory, 'move.mp4'))
  writeVideo(path.join(sourceDirectory, 'conflict.mp4'))
  writeVideo(path.join(destinationDirectory, 'conflict.mp4'))
  fs.mkdirSync(path.join(sourceDirectory, 'child'))

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const userNode = findFolder(root, '本地素材')
  const user = browser.browseMaterials({ folderId: userNode.id })
  const sourceNode = findFolder(user, 'source')
  const destinationNode = findFolder(user, 'destination')
  const source = browser.browseMaterials({ folderId: sourceNode.id })
  const childNode = findFolder(source, 'child')

  assert.throws(
    () => browser.moveMaterialFiles(sourceNode.id, destinationNode.id, source.files.map((file) => file.path)),
    /同名素材/,
  )
  assert.equal(fs.existsSync(path.join(sourceDirectory, 'move.mp4')), true)
  assert.equal(fs.existsSync(path.join(sourceDirectory, 'conflict.mp4')), true)

  const moved = browser.moveMaterialFiles(sourceNode.id, destinationNode.id, [path.join(sourceDirectory, 'move.mp4')])
  assert.equal(moved.moved, 1)
  assert.equal(fs.existsSync(path.join(sourceDirectory, 'move.mp4')), false)
  assert.equal(fs.existsSync(path.join(destinationDirectory, 'move.mp4')), true)

  assert.throws(() => browser.moveMaterialFolder(sourceNode.id, childNode.id), /自身或其子文件夹/)
  const folderMove = browser.moveMaterialFolder(sourceNode.id, destinationNode.id)
  assert.equal(folderMove.changed, true)
  assert.equal(fs.existsSync(sourceDirectory), false)
  assert.equal(fs.existsSync(path.join(destinationDirectory, 'source', 'conflict.mp4')), true)
})

test('folder creation and rename reject invalid or colliding names', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  fs.mkdirSync(path.join(materialsDir, 'rename-source'))
  fs.mkdirSync(path.join(materialsDir, 'existing-folder'))
  fs.writeFileSync(path.join(materialsDir, 'existing-file'), 'keep', 'utf8')

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const userNode = findFolder(root, '本地素材')
  const user = browser.browseMaterials({ folderId: userNode.id })
  const sourceNode = findFolder(user, 'rename-source')
  const invalidNames = [
    '',
    '   ',
    '.',
    '..',
    '../escaped',
    'folder/name',
    'folder\\name',
    'bad:name',
    'bad*name',
    'bad?name',
    'bad"name',
    'bad<name',
    'bad>name',
    'bad|name',
    'line\u0000break',
    ' leading',
    'trailing ',
    'trailing.',
    'CON',
    'com1.log',
    'a'.repeat(256),
  ]

  for (const invalidName of invalidNames) {
    assert.throws(() => browser.createMaterialFolder(userNode.id, invalidName), /文件夹名称/)
    assert.throws(() => browser.renameMaterialFolder(sourceNode.id, invalidName), /文件夹名称/)
  }
  assert.throws(() => browser.renameMaterialFolder(sourceNode.id, 'existing-folder'), /同名/)
  assert.throws(() => browser.renameMaterialFolder(sourceNode.id, 'EXISTING-FILE'), /同名/)
  assert.throws(() => browser.renameMaterialFolder(sourceNode.id, 'generated'), /受保护/)
  assert.throws(() => browser.renameMaterialFolder(sourceNode.id, '_indexed_h264'), /受保护/)
  assert.equal(browser.renameMaterialFolder(sourceNode.id, 'rename-source').changed, false)
})

test('opaque ids and links cannot expose files outside either material boundary', async (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-material-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  writeVideo(path.join(outside, 'outside.mp4'))
  writeVideo(path.join(materialsDir, 'safe-user', 'inside.mp4'))
  writeVideo(path.join(runsDir, 'safe-batch', 'raw', 'shot_safe', 'source.mp4'))

  let userLinked = true
  let rawLinked = true
  try {
    fs.symlinkSync(outside, path.join(materialsDir, 'escaped-user'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    userLinked = false
    t.diagnostic(`user link test skipped by host permissions: ${String(error)}`)
  }
  try {
    fs.symlinkSync(
      outside,
      path.join(runsDir, 'safe-batch', 'raw', 'escaped-raw'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch (error) {
    rawLinked = false
    t.diagnostic(`raw link test skipped by host permissions: ${String(error)}`)
  }

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const user = browser.browseMaterials({ folderId: findFolder(root, '本地素材').id })
  const downloads = browser.browseMaterials({ folderId: findFolder(root, '云端素材').id })
  const batch = browser.browseMaterials({ folderId: findFolder(downloads, 'safe-batch').id })

  assert.equal(user.current.id.includes(materialsDir), false)
  assert.throws(() => browser.browseMaterials({ folderId: 'C:\\outside\\folder' }), /无效/)
  assert.throws(() => browser.browseMaterials({ folderId: '../outside' }), /无效/)
  if (userLinked) assert.equal(user.folders.some(({ name }) => name === 'escaped-user'), false)
  if (rawLinked) assert.equal(batch.folders.some(({ name }) => name === 'escaped-raw'), false)
  assert.deepEqual(await browser.searchMaterialFolders({ query: 'escaped' }), [])
})

test('registered user and raw folders reject a boundary replaced by a link', (t) => {
  const { materialsDir, runsDir } = createWorkspace(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-material-swap-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  writeVideo(path.join(outside, 'outside.mp4'))
  writeVideo(path.join(materialsDir, 'replace-user', 'inside.mp4'))
  const rawDirectory = path.join(runsDir, 'replace-batch', 'raw')
  writeVideo(path.join(rawDirectory, 'shot_before', 'source.mp4'))

  const browser = createMaterialDirectoryBrowser({ materialsDir, runsDir })
  const root = browser.browseMaterials()
  const user = browser.browseMaterials({ folderId: findFolder(root, '本地素材').id })
  const userNode = findFolder(user, 'replace-user')
  const downloads = browser.browseMaterials({ folderId: findFolder(root, '云端素材').id })
  const batchNode = findFolder(downloads, 'replace-batch')

  fs.rmSync(path.join(materialsDir, 'replace-user'), { recursive: true })
  fs.rmSync(rawDirectory, { recursive: true })
  try {
    fs.symlinkSync(outside, path.join(materialsDir, 'replace-user'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(outside, rawDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`The host does not permit directory links: ${String(error)}`)
    return
  }

  assert.throws(() => browser.browseMaterials({ folderId: userNode.id }), /不存在或不可访问/)
  assert.throws(() => browser.browseMaterials({ folderId: batchNode.id }), /不存在或不可访问/)
  assert.throws(() => browser.getMaterialImportDirectory(userNode.id), /不存在或不可访问/)
})
