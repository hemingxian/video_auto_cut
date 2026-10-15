import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMaterialDetails,
  getMaterialMenuPosition,
  materialFileExtension,
  materialMenuItemsFor,
  materialRenameValue,
  materialRenameStem,
  materialTargetKey,
  validateMaterialRenameStem,
} from '../src/pages/materials/materialItemActionsModel.ts'

const file = {
  name: '产品演示.v2.mp4',
  path: 'C:\\private\\materials\\产品演示.v2.mp4',
  url: 'file:///private/materials/product.mp4',
  size: 2 * 1024 * 1024,
  mtime: 1_700_000_000_000,
  ext: '.mp4',
}
const fileTarget = { type: 'file', file }
const folderTarget = {
  type: 'folder',
  folder: {
    id: 'folder-user-project',
    name: '项目归档.v2',
    kind: 'user',
    folderCount: 3,
    videoCount: 8,
    canCreate: true,
    canImport: true,
    canRename: true,
    canDelete: true,
  },
}

test('material context menu uses a stable, compact action order', () => {
  assert.deepEqual(
    materialMenuItemsFor(fileTarget).map((item) => [item.action, item.label]),
    [
      ['details', '查看详情'],
      ['rename', '重命名'],
      ['delete', '删除'],
    ],
  )
  assert.deepEqual(
    materialMenuItemsFor({ type: 'file', file: { ...file, canMove: true } }).map((item) => item.action),
    ['details', 'rename', 'move', 'delete'],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'file',
      file: {
        ...file,
        materialId: 'mat_uploading_01',
        localStatus: 'present',
        cloudStatus: 'uploading',
        uploadTransferStatus: 'uploading',
      },
    }).map((item) => item.action),
    ['details', 'rename', 'pause_upload', 'cancel_upload', 'delete'],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'file',
      file: {
        ...file,
        materialId: 'mat_paused_01',
        localStatus: 'present',
        cloudStatus: 'uploading',
        uploadTransferStatus: 'paused',
      },
    }).map((item) => item.action),
    ['details', 'rename', 'resume_upload', 'cancel_upload', 'delete'],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'file',
      file: {
        ...file,
        materialId: 'mat_cloud_01',
        localStatus: 'present',
        cloudStatus: 'ready',
      },
    }).map((item) => [item.action, item.label]),
    [
      ['details', '查看详情'],
      ['rename', '重命名'],
      ['delete_local_copy', '删除本机副本'],
      ['delete_cloud_copy', '删除云端副本'],
      ['delete', '删除'],
    ],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'file',
      file: {
        ...file,
        materialId: 'mat_publish_01',
        localStatus: 'present',
        analysisStatus: 'ready',
        cloudAnalysisStatus: 'ready',
        cloudStatus: 'ready',
        publicationStatus: 'private',
      },
    }).map((item) => [item.action, item.label]),
    [
      ['details', '查看详情'],
      ['rename', '重命名'],
      ['publish', '申请公开'],
      ['delete_local_copy', '删除本机副本'],
      ['delete_cloud_copy', '删除云端副本'],
      ['delete', '删除'],
    ],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'file',
      file: {
        ...file,
        materialId: 'mat_public_01',
        localStatus: 'present',
        analysisStatus: 'ready',
        cloudAnalysisStatus: 'ready',
        cloudStatus: 'ready',
        publicationStatus: 'public',
        publicationId: 'pub_01',
      },
    }).map((item) => [item.action, item.label]),
    [
      ['details', '查看详情'],
      ['rename', '重命名'],
      ['withdraw_publication', '取消公开'],
      ['delete_local_copy', '删除本机副本'],
      ['delete', '删除'],
    ],
  )
  assert.deepEqual(
    materialMenuItemsFor(folderTarget).map((item) => item.action),
    ['details', 'create_folder', 'import_files', 'import_folder', 'rename', 'move', 'delete'],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'folder',
      folder: {
        ...folderTarget.folder,
        id: 'folder-system',
        canCreate: false,
        canImport: false,
        canRename: false,
        canDelete: false,
      },
    }).map((item) => item.action),
    ['details'],
  )
  assert.deepEqual(
    materialMenuItemsFor({
      type: 'folder',
      folder: {
        ...folderTarget.folder,
        id: 'folder-cloud-root',
        kind: 'cloud',
        canImport: false,
        canRename: false,
        canDelete: false,
      },
    }).map((item) => item.action),
    ['details', 'create_folder'],
  )
})

test('analysis transfer actions reuse available results and do not offer duplicate work in flight', () => {
  const base = { ...file, materialId: 'mat_analysis', localStatus: 'present', cloudStatus: 'ready',
    analysisStatus: 'ready', cloudAnalysisStatus: 'pending' }
  const actions = (overrides = {}) => materialMenuItemsFor({ type: 'file', file: { ...base, ...overrides } }).map(item => item.action)
  assert.ok(actions().includes('sync_analysis'))
  assert.equal(actions().includes('resume_upload'), false)
  assert.ok(actions({ analysisStatus: 'pending', cloudAnalysisStatus: 'ready' }).includes('restore_analysis'))
  assert.equal(actions({ localStatus: 'missing' }).includes('sync_analysis'), false)
  for (const status of ['queued', 'processing']) {
    assert.equal(actions({ analysisTransferStatus: status }).includes('sync_analysis'), false)
    assert.equal(actions({ analysisStatus: 'pending', cloudAnalysisStatus: 'ready', analysisTransferStatus: status }).includes('restore_analysis'), false)
  }
  assert.ok(actions({ analysisTransferStatus: 'failed', analysisTransferDirection: 'upload' }).includes('sync_analysis'))
  assert.ok(actions({ analysisTransferStatus: 'queued', analysisTransferDirection: 'upload', analysisTransferError: 'HTTP 503' }).includes('sync_analysis'))
  assert.ok(actions({ analysisStatus: 'pending', cloudAnalysisStatus: 'ready', analysisTransferStatus: 'failed', analysisTransferDirection: 'download' }).includes('restore_analysis'))
  assert.equal(actions({ cloudAnalysisStatus: 'ready' }).includes('sync_analysis'), false)
})

test('material context menu stays inside each viewport edge', () => {
  assert.deepEqual(getMaterialMenuPosition(20, 30, 1280, 720), { left: 20, top: 30 })
  assert.deepEqual(getMaterialMenuPosition(1278, 718, 1280, 720), { left: 1096, top: 606 })
  assert.deepEqual(getMaterialMenuPosition(1278, 718, 1280, 720, 1), { left: 1096, top: 670 })
  assert.deepEqual(getMaterialMenuPosition(-30, -20, 1280, 720), { left: 8, top: 8 })
  assert.deepEqual(getMaterialMenuPosition(50, 50, 140, 90), { left: 8, top: 8 })
})

test('material rename keeps the video extension separate from the editable stem', () => {
  assert.equal(materialFileExtension(file), '.mp4')
  assert.equal(materialRenameStem(file), '产品演示.v2')
  assert.equal(materialFileExtension({ ...file, ext: '', name: '片段.MOV' }), '.MOV')
  assert.equal(materialRenameStem({ ...file, ext: '.MP4' }), '产品演示.v2')
  assert.equal(materialRenameValue(fileTarget), '产品演示.v2')
  assert.equal(materialRenameValue(folderTarget), '项目归档.v2')
  assert.equal(materialTargetKey(fileTarget), file.path)
  assert.equal(materialTargetKey(folderTarget), folderTarget.folder.id)
})

test('material rename validation rejects unsafe file names', () => {
  assert.equal(validateMaterialRenameStem('  新名称  '), '')
  assert.equal(validateMaterialRenameStem(''), '请输入素材名称')
  assert.equal(validateMaterialRenameStem('..'), '素材名称无效')
  assert.match(validateMaterialRenameStem('a/b'), /不能包含/)
  assert.match(validateMaterialRenameStem('video.'), /不能以/)
  assert.match(validateMaterialRenameStem('CON'), /系统保留/)
  assert.match(validateMaterialRenameStem('a'.repeat(181)), /180/)
  assert.equal(validateMaterialRenameStem('', 'folder'), '请输入文件夹名称')
  assert.equal(validateMaterialRenameStem('..', 'folder'), '文件夹名称无效')
})

test('material details never expose the local path or URL', () => {
  const details = createMaterialDetails(fileTarget)
  const serialized = JSON.stringify(details)

  assert.deepEqual(details.map((item) => item.label), ['名称', '类型', '格式', '大小', '修改时间'])
  assert.match(serialized, /产品演示\.v2\.mp4/)
  assert.match(serialized, /2\.0 MB/)
  assert.doesNotMatch(serialized, /private|materials|file:/i)
  assert.doesNotMatch(serialized, /"path"|"url"/i)

  const folderDetails = createMaterialDetails(folderTarget)
  const folderSerialized = JSON.stringify(folderDetails)
  assert.deepEqual(folderDetails.map((item) => item.label), ['名称', '类型', '子文件夹', '视频'])
  assert.match(folderSerialized, /项目归档\.v2/)
  assert.match(folderSerialized, /3 个/)
  assert.match(folderSerialized, /8 个/)
  assert.doesNotMatch(folderSerialized, /folder-user-project|"id"/)
})
