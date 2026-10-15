import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createExtractProgressEmitter,
  extractZipWithProgress,
  safeZipTarget,
} from '../electron/runtime-archive.ts'

test('safeZipTarget keeps valid entries inside the extraction directory', () => {
  const destination = path.resolve('C:\\runtime-test')
  const nested = safeZipTarget(destination, 'VideoAutoCut/bin/engine.exe')
  const backslashEntry = safeZipTarget(destination, 'VideoAutoCut\\config\\app.env')

  assert.equal(path.relative(destination, nested), path.join('VideoAutoCut', 'bin', 'engine.exe'))
  assert.equal(path.relative(destination, backslashEntry), path.join('VideoAutoCut', 'config', 'app.env'))
})

test('safeZipTarget rejects absolute, empty and traversal entries', () => {
  const destination = path.resolve('C:\\runtime-test')
  const unsafeEntries = [
    '',
    '../outside.exe',
    'nested/../../outside.exe',
    '/absolute/outside.exe',
    'C:\\outside.exe',
    '\\\\server\\share\\outside.exe',
  ]

  for (const entry of unsafeEntries) {
    assert.throws(() => safeZipTarget(destination, entry), /runtime zip contains an unsafe path/)
  }
})

test('byte progress is throttled, monotonic and forced to completion', () => {
  let currentTime = 1_000
  const snapshots = []
  const progress = createExtractProgressEmitter(100, 2, (snapshot) => snapshots.push(snapshot), () => currentTime)

  progress.start()
  currentTime += 100
  progress.addBytes(25)
  currentTime += 100
  progress.addBytes(25)
  currentTime += 200
  progress.addBytes(-50)
  progress.finish()

  assert.deepEqual(snapshots, [
    { percent: 0, transferred: 0, total: 100 },
    { percent: 50, transferred: 50, total: 100 },
    { percent: 50, transferred: 50, total: 100 },
    { percent: 100, transferred: 100, total: 100 },
  ])
})

test('file-count progress is used when the archive has no byte total', () => {
  let currentTime = 1_000
  const snapshots = []
  const progress = createExtractProgressEmitter(0, 2, (snapshot) => snapshots.push(snapshot), () => currentTime)

  progress.start()
  currentTime += 200
  progress.finishFile()
  currentTime += 200
  progress.finishFile()
  progress.finish()

  assert.deepEqual(snapshots.map(({ percent }) => percent), [0, 50, 100, 100])
  assert.deepEqual(snapshots.at(-1), { percent: 100, transferred: 2, total: 2 })
})

test('extractZipWithProgress rejects a corrupt archive without emitting progress', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-runtime-archive-'))
  const archivePath = path.join(tempRoot, 'corrupt.zip')
  const destination = path.join(tempRoot, 'output')
  const snapshots = []
  fs.writeFileSync(archivePath, 'not a zip archive', 'utf8')

  try {
    await assert.rejects(extractZipWithProgress(archivePath, destination, (progress) => snapshots.push(progress)))
    assert.equal(fs.existsSync(destination), true)
    assert.deepEqual(snapshots, [])
  } finally {
    const resolvedTempRoot = path.resolve(tempRoot)
    const resolvedSystemTemp = path.resolve(os.tmpdir())
    assert.equal(resolvedTempRoot.startsWith(`${resolvedSystemTemp}${path.sep}`), true)
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true })
  }
})
