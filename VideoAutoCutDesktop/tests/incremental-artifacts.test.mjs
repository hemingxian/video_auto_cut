import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readIncrementalArtifacts } from '../dist-electron/incremental-artifacts.js'
import { buildShotMaterialBoard } from '../src/pages/start/shotArtifacts.ts'

test('incremental inventory reads only current receipts and groups reordered clips by stable shot identity', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-incremental-artifacts-'))
  const root = path.join(base, 'run_isolated')
  t.after(() => {
    assert.ok(path.resolve(base).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
    fs.rmSync(base, { recursive: true, force: true })
  })
  const write = (relative, content = 'video fixture') => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file
  }
  const a = write('raw/cache-a/current/01 · A/a.mp4')
  write('raw/cache-a/obsolete/01 · A/old.mp4')
  write('raw/cache-a/current/01 · A/_indexed_h264/index.mp4')
  const b = write('raw/cache-b/current/02 · B/b.mp4')
  const clipA = write('clips/cache-a/version/01 · A/match.mp4')
  const clipB = write('clips/cache-b/version/02 · B/match.mp4')
  const outside = path.join(base, 'outside.mp4'); fs.writeFileSync(outside, 'outside')
  const shots = [{ shot_id: 'b', shot: 1, title: 'B', material_bindings: [] }, { shot_id: 'a', shot: 2, title: 'A', material_bindings: [] }]
  write('shots.json', JSON.stringify({ task_revision: 7, shots }))
  write('incremental.json', JSON.stringify({ schema_version: 1, records: {
    // Rust canonicalize writes Windows extended-length paths into real receipts.
    'download:a': { files: { [path.toNamespacedPath(a)]: 'hash-a', [path.toNamespacedPath(outside)]: 'foreign', [path.join(root, 'missing.mp4')]: 'missing' } },
    'download:b': { files: { [path.toNamespacedPath(b)]: 'hash-b' } },
    'download:removed': { files: { [outside]: 'foreign' } },
  } }))
  const manifest = { schema_version: 1, task_revision: 7, run_id: 'run_isolated', shots: [
    { shot_id: 'a', paths: [path.relative(path.join(root, 'clips'), clipA)] },
    { shot_id: 'b', paths: [path.relative(path.join(root, 'clips'), clipB)] },
  ] }
  write('clips/clip_manifest.json', JSON.stringify(manifest))
  const current = readIncrementalArtifacts(root)
  assert.deepEqual(readIncrementalArtifacts(path.toNamespacedPath(root)), current)
  assert.equal(current.length, 4)
  assert.deepEqual(current.filter(item => item.stage === 'raw').map(item => item.path).sort(), [a, b].sort())
  const board = buildShotMaterialBoard(shots, { artifacts: current.map(item => ({ ...item, name: path.basename(item.path), ext: '.mp4', relativePath: path.relative(root, item.path) })) })
  assert.equal(board.rows[0].clipArtifacts[0].path, clipB)
  assert.equal(board.rows[1].clipArtifacts[0].path, clipA)
  assert.equal(board.candidateCount, 2)
  write('clips/clip_manifest.json', JSON.stringify({ ...manifest, task_revision: 6 }))
  assert.equal(readIncrementalArtifacts(root).filter(item => item.stage === 'clips').length, 0)
  write('incremental.json', 'corrupt')
  assert.deepEqual(readIncrementalArtifacts(root), [])
  fs.unlinkSync(path.join(root, 'incremental.json'))
  assert.equal(readIncrementalArtifacts(root), null)
})
