import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  replaceDirectoryAtomically,
  resolveRuntimeVersionDirectory,
  validateRuntimeVersion,
  writeFileAtomically,
} from '../electron/runtime-install.ts'

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-runtime-install-'))
  t.after(() => {
    const resolvedRoot = path.resolve(root)
    const resolvedSystemTemp = path.resolve(os.tmpdir())
    assert.equal(resolvedRoot.startsWith(`${resolvedSystemTemp}${path.sep}`), true)
    fs.rmSync(resolvedRoot, { recursive: true, force: true })
  })
  return root
}

function createRuntime(directory, marker) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'engine.exe'), marker, 'utf8')
}

function validateRuntime(directory) {
  if (!fs.existsSync(path.join(directory, 'engine.exe'))) throw new Error('engine missing')
}

test('runtime versions resolve to one safe directory segment', () => {
  const base = path.resolve('runtime-base')
  for (const version of ['0', 'v1.2.3', '1.2.3-beta_1-build5']) {
    assert.equal(validateRuntimeVersion(version), version)
    assert.equal(path.relative(base, resolveRuntimeVersionDirectory(base, version)), version)
  }

  for (const version of ['', '.', '..', '../outside', 'nested/version', 'nested\\version', 'C:\\outside', '1.0.0.', '1.0+build', 'v'.repeat(129)]) {
    assert.throws(() => validateRuntimeVersion(version), /unsafe runtime version/)
  }
})

test('replaceDirectoryAtomically promotes a validated runtime and removes its backup', (t) => {
  const root = temporaryRoot(t)
  const target = path.join(root, '1.0.0')
  const staging = `${target}.tmp`
  const backup = `${target}.backup`
  createRuntime(target, 'old')
  createRuntime(staging, 'new')

  replaceDirectoryAtomically({
    targetDirectory: target,
    stagingDirectory: staging,
    backupDirectory: backup,
    validate: validateRuntime,
  })

  assert.equal(fs.readFileSync(path.join(target, 'engine.exe'), 'utf8'), 'new')
  assert.equal(fs.existsSync(staging), false)
  assert.equal(fs.existsSync(backup), false)
})

test('a staging validation failure leaves the installed runtime untouched', (t) => {
  const root = temporaryRoot(t)
  const target = path.join(root, '1.0.0')
  const staging = `${target}.tmp`
  createRuntime(target, 'old')
  fs.mkdirSync(staging, { recursive: true })

  assert.throws(() => replaceDirectoryAtomically({
    targetDirectory: target,
    stagingDirectory: staging,
    validate: validateRuntime,
  }), /engine missing/)

  assert.equal(fs.readFileSync(path.join(target, 'engine.exe'), 'utf8'), 'old')
  assert.equal(fs.existsSync(staging), false)
  assert.equal(fs.existsSync(`${target}.backup`), false)
})

test('a promoted runtime validation failure restores the previous directory', (t) => {
  const root = temporaryRoot(t)
  const target = path.join(root, '1.0.0')
  const staging = `${target}.tmp`
  createRuntime(target, 'old')
  createRuntime(staging, 'new')
  let validationCount = 0

  assert.throws(() => replaceDirectoryAtomically({
    targetDirectory: target,
    stagingDirectory: staging,
    validate: () => {
      validationCount += 1
      if (validationCount > 1) throw new Error('promoted runtime invalid')
    },
  }), /promoted runtime invalid/)

  assert.equal(fs.readFileSync(path.join(target, 'engine.exe'), 'utf8'), 'old')
  assert.equal(fs.existsSync(staging), false)
  assert.equal(fs.existsSync(`${target}.backup`), false)
})

test('a rollback rename failure reports both failures and preserves the backup', (t) => {
  const root = temporaryRoot(t)
  const target = path.join(root, '1.0.0')
  const staging = `${target}.tmp`
  const backup = `${target}.backup`
  createRuntime(target, 'old')
  createRuntime(staging, 'new')
  let validationCount = 0

  assert.throws(() => replaceDirectoryAtomically({
    targetDirectory: target,
    stagingDirectory: staging,
    backupDirectory: backup,
    validate: () => {
      validationCount += 1
      if (validationCount > 1) throw new Error('promoted runtime invalid')
    },
    operations: {
      exists: fs.existsSync,
      remove: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
      rename: (source, destination) => {
        if (source === backup && destination === target) throw new Error('restore denied')
        fs.renameSync(source, destination)
      },
    },
  }), /promoted runtime invalid; rollback failed: restore denied/)

  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.readFileSync(path.join(backup, 'engine.exe'), 'utf8'), 'old')
  assert.equal(fs.existsSync(staging), false)

  createRuntime(staging, 'retry')
  replaceDirectoryAtomically({
    targetDirectory: target,
    stagingDirectory: staging,
    backupDirectory: backup,
    validate: validateRuntime,
  })
  assert.equal(fs.readFileSync(path.join(target, 'engine.exe'), 'utf8'), 'retry')
  assert.equal(fs.existsSync(backup), false)
})

test('writeFileAtomically replaces an existing runtime record without temporary files', (t) => {
  const root = temporaryRoot(t)
  const target = path.join(root, 'current.json')
  fs.writeFileSync(target, '{"version":"old"}', 'utf8')

  writeFileAtomically(target, '{"version":"new"}')

  assert.equal(fs.readFileSync(target, 'utf8'), '{"version":"new"}')
  assert.deepEqual(fs.readdirSync(root), ['current.json'])
})

test('writeFileAtomically keeps the previous record and removes its temp file on rename failure', (t) => {
  const root = temporaryRoot(t)
  const target = path.join(root, 'current.json')
  fs.writeFileSync(target, '{"version":"old"}', 'utf8')

  assert.throws(() => writeFileAtomically(target, '{"version":"new"}', {
    exists: fs.existsSync,
    remove: (file) => fs.rmSync(file, { force: true }),
    rename: () => { throw new Error('replace denied') },
    write: (file, contents) => fs.writeFileSync(file, contents, 'utf8'),
  }), /replace denied/)

  assert.equal(fs.readFileSync(target, 'utf8'), '{"version":"old"}')
  assert.deepEqual(fs.readdirSync(root), ['current.json'])
})
