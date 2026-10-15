import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterReferenceMaterials,
  summarizeReferenceSelections,
  toggleReferenceSelection,
  toggleReferenceSubfolders,
} from '../src/pages/material-workflow-reference/model.ts'

const folder = {
  id: 'product',
  kind: 'folder',
  name: '产品展示',
  videoCount: 12,
}
const material = {
  id: 'hero',
  kind: 'material',
  name: '主镜头.mp4',
}

test('reference selection toggles without mutating the previous list', () => {
  const initial = [folder]
  const added = toggleReferenceSelection(initial, material)
  const removed = toggleReferenceSelection(added, folder)

  assert.equal(initial.length, 1)
  assert.deepEqual(added.map((item) => item.id), ['product', 'hero'])
  assert.deepEqual(removed.map((item) => item.id), ['hero'])
})

test('reference selection summary includes folder candidates and files', () => {
  assert.deepEqual(summarizeReferenceSelections([folder, material]), {
    folderCount: 1,
    materialCount: 1,
    candidateCount: 13,
  })
})

test('subfolder toggle only updates the target folder', () => {
  const toggled = toggleReferenceSubfolders([folder, material], 'product')
  assert.equal(toggled[0].includeSubfolders, true)
  assert.equal(toggled[1], material)
})

test('material filtering combines query and storage status', () => {
  const materials = [
    {
      id: 'one',
      name: '产品主镜头.mp4',
      folderName: '产品展示',
      status: 'ready',
      storage: 'both',
    },
    {
      id: 'two',
      name: '园区空镜.mp4',
      folderName: '工业园区',
      status: 'failed',
      storage: 'local',
    },
  ]

  assert.deepEqual(
    filterReferenceMaterials(materials, '产品', 'cloud').map((item) => item.id),
    ['one'],
  )
  assert.deepEqual(
    filterReferenceMaterials(materials, '', 'failed').map((item) => item.id),
    ['two'],
  )
})
