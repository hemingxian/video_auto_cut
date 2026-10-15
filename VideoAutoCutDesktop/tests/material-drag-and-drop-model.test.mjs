import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMaterialDragData,
  readMaterialDragData,
} from '../src/pages/materials/materialDragAndDropModel.ts'

test('material drag data removes duplicate and empty file paths', () => {
  assert.deepEqual(createMaterialDragData(['a.mp4', '', 'a.mp4', 'b.mov'], 'source'), {
    kind: 'video-auto-cut/material-files',
    paths: ['a.mp4', 'b.mov'],
    sourceFolderId: 'source',
  })
})

test('material drag data rejects unrelated or malformed payloads', () => {
  assert.equal(readMaterialDragData({ kind: 'text', paths: ['a.mp4'], sourceFolderId: 'source' }), null)
  assert.equal(readMaterialDragData({
    kind: 'video-auto-cut/material-files',
    paths: [42],
    sourceFolderId: 'source',
  }), null)
  assert.equal(readMaterialDragData({
    kind: 'video-auto-cut/material-files',
    paths: [],
    sourceFolderId: 'source',
  }), null)
})

test('material drag data accepts a valid external record', () => {
  assert.deepEqual(readMaterialDragData({
    kind: 'video-auto-cut/material-files',
    paths: ['a.mp4', 'a.mp4'],
    sourceFolderId: 'source',
  }), {
    kind: 'video-auto-cut/material-files',
    paths: ['a.mp4'],
    sourceFolderId: 'source',
  })
})
