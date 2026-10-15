import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createMaterialFileOperations } from '../dist-electron/material-file-operations.js'

function isInside(target, boundary) {
  const relative = path.relative(boundary, target)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function existingPathAndRemainder(target) {
  let existing = target
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  return {
    existing,
    remainder: path.relative(existing, target),
  }
}

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-material-rename-'))
  const realRoot = fs.realpathSync(root)
  const materialsDir = path.join(realRoot, 'video', 'materials')
  fs.mkdirSync(materialsDir, { recursive: true })

  t.after(() => {
    assert.equal(isInside(realRoot, fs.realpathSync(os.tmpdir())), true)
    fs.rmSync(realRoot, { recursive: true, force: true })
  })

  const assertInsideWorkspace = (target) => {
    const resolved = path.resolve(String(target || ''))
    const { existing, remainder } = existingPathAndRemainder(resolved)
    const canonicalTarget = path.resolve(fs.realpathSync(existing), remainder)
    if (!isInside(canonicalTarget, realRoot)) throw new Error('路径不在工作区内')
    return resolved
  }
  const samePath = (first, second) => (
    path.resolve(String(first || '')).toLocaleLowerCase()
      === path.resolve(String(second || '')).toLocaleLowerCase()
  )

  return {
    root: realRoot,
    materialsDir,
    operations: createMaterialFileOperations({ assertInsideWorkspace, samePath }),
  }
}

function writeVideo(directory, name = 'original.mp4') {
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'test-video', 'utf8')
  return fs.realpathSync(file)
}

test('renames a video and returns its previous path and refreshed FileEntry', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'original.MP4')

  const result = operations.renameMaterialFile(source, '成片')
  const expected = path.join(materialsDir, '成片.MP4')

  assert.equal(result.previousPath, source)
  assert.equal(result.changed, true)
  assert.equal(result.file.name, '成片.MP4')
  assert.equal(result.file.path, expected)
  assert.equal(result.file.ext, '.mp4')
  assert.equal(result.file.size, Buffer.byteLength('test-video'))
  assert.match(result.file.url, /^videoauto-media:/)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.readFileSync(expected, 'utf8'), 'test-video')
})

test('locates the hidden indexed copy that corresponds to each sorted original video', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const shotDirectory = path.join(materialsDir, 'shot')
  const second = writeVideo(shotDirectory, 'b-source.webm')
  const first = writeVideo(shotDirectory, 'a-source.mp4')
  const indexDirectory = path.join(shotDirectory, '_indexed_h264')
  const firstIndexed = writeVideo(indexDirectory, '001_a-source.mp4')
  const secondIndexed = writeVideo(indexDirectory, '002_b-source.mp4')
  writeVideo(indexDirectory, '003_stale.mp4')

  assert.deepEqual(operations.findIndexedCopies(first), [firstIndexed])
  assert.deepEqual(operations.findIndexedCopies(second), [secondIndexed])
  fs.rmSync(first)
  assert.deepEqual(operations.findIndexedCopies(second), [secondIndexed])
  assert.deepEqual(
    operations.findIndexedCopies(path.join(shotDirectory, 'missing.mp4')),
    [],
  )
})

test('accepts a full file name while always preserving the original extension', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'source.webm')

  const result = operations.renameMaterialFile(source, 'renamed.WEBM')

  assert.equal(result.file.name, 'renamed.webm')
  assert.equal(result.file.ext, '.webm')
  assert.equal(fs.existsSync(path.join(materialsDir, 'renamed.webm')), true)
})

test('returns the current FileEntry without touching the file for an unchanged name', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'unchanged.mov')
  const before = fs.statSync(source)

  const result = operations.renameMaterialFile(source, 'unchanged.mov')

  assert.equal(result.previousPath, source)
  assert.equal(result.changed, false)
  assert.equal(result.file.path, source)
  assert.equal(result.file.mtime, before.mtimeMs)
  assert.equal(fs.readFileSync(source, 'utf8'), 'test-video')
})

test('supports file-name case changes through a temporary same-directory rename', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'Camera-A.mp4')

  const result = operations.renameMaterialFile(source, 'camera-a')
  const entries = fs.readdirSync(materialsDir)

  assert.equal(result.changed, true)
  assert.equal(result.previousPath, source)
  assert.equal(result.file.name, 'camera-a.mp4')
  assert.deepEqual(entries, ['camera-a.mp4'])
  assert.equal(entries.some((name) => name.startsWith('.videoautocut-rename-')), false)
})

test('rejects an existing destination without replacing either file', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'first.mp4')
  const destination = writeVideo(materialsDir, 'second.mp4')
  fs.writeFileSync(destination, 'keep-destination', 'utf8')

  assert.throws(
    () => operations.renameMaterialFile(source, 'second'),
    /同目录下已存在同名文件/,
  )
  assert.equal(fs.readFileSync(source, 'utf8'), 'test-video')
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep-destination')
})

test('rejects a case-insensitive collision when it is a different physical file', (t) => {
  if (process.platform === 'win32') {
    t.skip('A case-insensitive Windows file system cannot create both test names')
    return
  }

  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'clip.mp4')
  writeVideo(materialsDir, 'CLIP.mp4')

  assert.throws(
    () => operations.renameMaterialFile(source, 'CLIP'),
    /同目录下已存在同名文件/,
  )
})

test('only existing regular video files may be renamed', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const textFile = path.join(materialsDir, 'notes.txt')
  const directory = path.join(materialsDir, 'folder.mp4')
  fs.writeFileSync(textFile, 'notes', 'utf8')
  fs.mkdirSync(directory)

  assert.throws(
    () => operations.renameMaterialFile(textFile, 'renamed'),
    /只允许重命名视频素材文件/,
  )
  assert.throws(
    () => operations.renameMaterialFile(path.join(materialsDir, 'missing.mp4'), 'renamed'),
    /素材文件不存在/,
  )
  assert.throws(
    () => operations.renameMaterialFile(directory, 'renamed'),
    /目标不是视频素材文件/,
  )
})

test('rejects files and rename targets outside the injected workspace boundary', (t) => {
  const { operations } = createWorkspace(t)
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-material-outside-'))
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }))
  const outsideFile = writeVideo(outsideRoot, 'outside.mp4')

  assert.throws(
    () => operations.renameMaterialFile(outsideFile, 'renamed'),
    /路径不在工作区内/,
  )
})

test('rejects symbolic-link files instead of following them', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir, 'real.mp4')
  const link = path.join(materialsDir, 'linked.mp4')

  try {
    fs.symlinkSync(source, link, 'file')
  } catch (error) {
    t.skip(`The host does not permit file symlinks: ${String(error)}`)
    return
  }

  assert.throws(
    () => operations.renameMaterialFile(link, 'renamed'),
    /不允许重命名符号链接文件/,
  )
  assert.equal(fs.existsSync(source), true)
})

test('rejects paths that enter the workspace through a linked directory', (t) => {
  const { root, operations } = createWorkspace(t)
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-linked-outside-'))
  const outsideFile = writeVideo(outsideRoot, 'outside.mp4')
  const linkedDirectory = path.join(root, 'linked-outside')
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }))

  try {
    fs.symlinkSync(outsideRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`The host does not permit directory links: ${String(error)}`)
    return
  }

  assert.throws(
    () => operations.renameMaterialFile(path.join(linkedDirectory, path.basename(outsideFile)), 'renamed'),
    /路径不在工作区内/,
  )
  assert.equal(fs.existsSync(outsideFile), true)
})

test('rejects empty, traversal, control-character, and Windows-invalid names', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir)
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
    'line-break\n',
    'trailing.',
    'trailing. ',
  ]

  for (const invalidName of invalidNames) {
    assert.throws(
      () => operations.renameMaterialFile(source, invalidName),
      /文件名/,
      `expected invalid name to fail: ${JSON.stringify(invalidName)}`,
    )
  }
})

test('rejects Windows device names including names followed by another suffix', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir)

  for (const reservedName of [
    'CON',
    'con.txt',
    'PRN',
    'AUX',
    'NUL',
    'CLOCK$',
    'COM1',
    'com9.log',
    'COM¹',
    'LPT1',
    'lpt9',
    'LPT³.txt',
  ]) {
    assert.throws(
      () => operations.renameMaterialFile(source, reservedName),
      /Windows 保留名称/,
      `expected reserved name to fail: ${reservedName}`,
    )
  }
})

test('rejects names longer than a file-system component', (t) => {
  const { materialsDir, operations } = createWorkspace(t)
  const source = writeVideo(materialsDir)

  assert.throws(
    () => operations.renameMaterialFile(source, 'a'.repeat(252)),
    /不能超过 255 个字符/,
  )
})
