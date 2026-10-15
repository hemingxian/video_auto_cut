import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertReleaseVersion,
  currentDesktopVersion,
  currentRuntimeVersion,
  setDesktopVersion,
} from '../scripts/release-version.ts'

function temporaryReleaseRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-release-version-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.5' }))
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    version: '0.4.5',
    packages: { '': { version: '0.4.5' } },
  }))
  return root
}

test('release versions require a valid semantic version', () => {
  assert.equal(assertReleaseVersion('0.4.6'), '0.4.6')
  assert.equal(assertReleaseVersion('1.0.0-beta.1'), '1.0.0-beta.1')
  assert.throws(() => assertReleaseVersion('0.4'), /格式不正确/)
  assert.throws(() => assertReleaseVersion('next'), /格式不正确/)
})

test('desktop version update keeps package and lock versions aligned', (t) => {
  const root = temporaryReleaseRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.equal(setDesktopVersion(root, '0.4.6'), '0.4.6')
  assert.equal(currentDesktopVersion(root), '0.4.6')
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, '0.4.6')
  assert.equal(lock.packages[''].version, '0.4.6')
})

test('runtime version is independent when a runtime manifest exists', (t) => {
  const root = temporaryReleaseRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'runtime-release'))
  fs.writeFileSync(path.join(root, 'runtime-release', 'manifest.json'), JSON.stringify({ latest: '0.4.8' }))

  assert.equal(currentDesktopVersion(root), '0.4.5')
  assert.equal(currentRuntimeVersion(root), '0.4.8')
})
