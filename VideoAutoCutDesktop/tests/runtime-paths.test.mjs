import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntimePathState, prepareDevelopmentDependencies } from '../electron/runtime-paths.ts'

test('development uses source tools and only fills missing binary dependencies', (t) => {
  const root = temporaryRoot(t)
  const development = path.join(root, 'dev')
  const installed = path.join(root, 'installed')
  touch(path.join(development, 'tools', 'output_format.py'))
  touch(path.join(installed, 'python-3.11.9-embed-amd64', 'python.exe'))
  touch(path.join(installed, 'sentrysearch', '.venv', 'Lib', 'site-packages', 'click', '__init__.py'))
  touch(path.join(installed, 'yt-dlp.exe'))
  fs.writeFileSync(path.join(development, 'yt-dlp.exe'), 'keep')
  prepareDevelopmentDependencies(development, installed)
  prepareDevelopmentDependencies(development, installed)
  assert.ok(fs.existsSync(path.join(development, 'python-3.11.9-embed-amd64', 'python.exe')))
  assert.ok(fs.existsSync(path.join(development, 'sentrysearch', '.venv', 'Lib', 'site-packages', 'click', '__init__.py')))
  assert.equal(fs.readFileSync(path.join(development, 'yt-dlp.exe'), 'utf8'), 'keep')
  assert.ok(fs.existsSync(path.join(development, 'tools', 'output_format.py')))
})

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videoautocut-runtime-paths-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '')
}

test('sentry search prefers the portable bundled Python runtime', (t) => {
  const root = temporaryRoot(t)
  const bundledPython = path.join(root, 'python-3.11.9-embed-amd64', 'python.exe')
  const virtualEnvPython = path.join(root, 'sentrysearch', '.venv', 'Scripts', 'python.exe')
  touch(bundledPython)
  touch(virtualEnvPython)

  const runtime = createRuntimePathState({ initialRoot: root, engineExeName: 'engine.exe' })

  assert.equal(runtime.sentrySearchPython, bundledPython)
})

test('sentry search falls back to its virtual environment when needed', (t) => {
  const root = temporaryRoot(t)
  const virtualEnvPython = path.join(root, 'sentrysearch', '.venv', 'Scripts', 'python.exe')
  touch(virtualEnvPython)

  const runtime = createRuntimePathState({ initialRoot: root, engineExeName: 'engine.exe' })

  assert.equal(runtime.sentrySearchPython, virtualEnvPython)
})
