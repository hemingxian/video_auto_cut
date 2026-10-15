import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { stageBundledFonts, verifyBundledFonts } from '../scripts/bundled-fonts.ts'
import { verifyTemplateRuntime } from '../scripts/template-runtime.ts'

test('runtime packaging rejects missing fixed-template render dependencies', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'videoauto-template-runtime-'))
  try {
    assert.throws(() => verifyTemplateRuntime(target), /模板包装运行组件未打包完整/)
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('runtime font staging carries both original fonts and verified licensing', () => {
  const source = fileURLToPath(new URL('../../VideoAutoCut/fonts/noto-sans-cjk-sc', import.meta.url))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'videoauto-font-test-'))
  try {
    stageBundledFonts(source, target)
    const manifest = verifyBundledFonts(target)
    assert.equal(manifest.family, 'Noto Sans CJK SC')
    assert.match(fs.readFileSync(path.join(target, 'LICENSE'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/)
    assert.deepEqual(manifest.files.map((entry) => entry.file), ['NotoSansCJKsc-Regular.otf', 'NotoSansCJKsc-Bold.otf', 'LICENSE'])
    fs.appendFileSync(path.join(target, 'LICENSE'), 'damaged')
    assert.throws(() => verifyBundledFonts(target), /校验失败/)
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

import {
  parseRuntimeBaseManifest,
  safeRuntimeZipTarget,
} from '../scripts/runtime-release-base.ts'

test('runtime release base selects and validates the latest HTTPS archive', () => {
  const sha256 = 'a'.repeat(64)
  const release = parseRuntimeBaseManifest({
    latest: '0.4.7',
    versions: [{
      version: '0.4.7',
      url: './VideoAutoCut-runtime-0.4.7.zip',
      sha256,
      size: 123,
    }],
  }, 'https://download.example.com/runtime/manifest.json')

  assert.deepEqual(release, {
    version: '0.4.7',
    url: 'https://download.example.com/runtime/VideoAutoCut-runtime-0.4.7.zip',
    sha256,
    size: 123,
  })
})

test('runtime release base rejects insecure downloads and invalid fingerprints', () => {
  assert.throws(() => parseRuntimeBaseManifest({
    latest: '0.4.7',
    versions: [{ version: '0.4.7', url: 'http://download.example.com/runtime.zip', sha256: 'a'.repeat(64), size: 1 }],
  }, 'https://download.example.com/manifest.json'), /HTTPS/)

  assert.throws(() => parseRuntimeBaseManifest({
    latest: '0.4.7',
    versions: [{ version: '0.4.7', url: 'https://download.example.com/runtime.zip', sha256: 'bad', size: 1 }],
  }, 'https://download.example.com/manifest.json'), /SHA-256/)
})

test('runtime release base keeps extracted files inside its cache root', () => {
  const root = path.resolve('runtime-cache-test')
  assert.equal(safeRuntimeZipTarget(root, 'VideoAutoCut/tools/run.py'), path.join(root, 'VideoAutoCut', 'tools', 'run.py'))
  assert.throws(() => safeRuntimeZipTarget(root, '../escape.exe'), /不安全路径/)
  assert.throws(() => safeRuntimeZipTarget(root, 'C:/escape.exe'), /不安全路径/)
})
