import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  createLocalMediaUrl,
  parseMediaRange,
  resolveLocalMediaPath,
} from '../dist-electron/local-media-protocol.js'

test('local media urls round-trip only inside the managed data root', () => {
  const root = path.resolve('managed-data')
  const video = path.join(root, 'video', 'materials', '示例素材.mp4')
  const url = createLocalMediaUrl(video)

  assert.match(url, /^videoauto-media:\/\/file\//)
  assert.equal(resolveLocalMediaPath(url, root), path.resolve(video))
  assert.throws(
    () => resolveLocalMediaPath(createLocalMediaUrl(path.resolve('outside', 'private.mp4')), root),
    /不在允许的工作目录/,
  )
})

test('local media byte ranges support seeking and reject invalid requests', () => {
  assert.deepEqual(parseMediaRange(null, 100), null)
  assert.deepEqual(parseMediaRange('bytes=0-', 100), { start: 0, end: 99 })
  assert.deepEqual(parseMediaRange('bytes=20-39', 100), { start: 20, end: 39 })
  assert.deepEqual(parseMediaRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.throws(() => parseMediaRange('bytes=100-', 100), /无效/)
  assert.throws(() => parseMediaRange('items=0-10', 100), /无效/)
})
