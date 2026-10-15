import assert from 'node:assert/strict'
import test from 'node:test'

import {
  desktopReleaseFileNames,
  objectKey,
  parseReleaseUploadConfig,
  releasePublicUrls,
  releaseTargets,
} from '../scripts/release-upload-config.ts'

test('release config derives COS public URLs for desktop and runtime', () => {
  const config = parseReleaseUploadConfig({
    secretId: 'id',
    secretKey: 'key',
    bucket: 'video-1250000000',
    region: 'ap-chengdu',
    desktopPrefix: '/updates/',
    runtimePrefix: 'runtime',
  })

  assert.deepEqual(releasePublicUrls(config), {
    desktop: 'https://video-1250000000.cos.ap-chengdu.myqcloud.com/updates',
    runtime: 'https://video-1250000000.cos.ap-chengdu.myqcloud.com/runtime',
  })
  assert.equal(objectKey(config.desktopPrefix, 'latest.yml'), 'updates/latest.yml')
})

test('release config uses the configured CDN or custom domain', () => {
  const config = parseReleaseUploadConfig({
    bucket: 'video-1250000000',
    region: 'ap-chengdu',
    publicBaseUrl: 'https://download.example.com/',
  }, { requireCredentials: false })

  assert.deepEqual(releasePublicUrls(config), {
    desktop: 'https://download.example.com/updates',
    runtime: 'https://download.example.com/runtime',
  })
})

test('release config rejects unsafe object prefixes', () => {
  assert.throws(() => parseReleaseUploadConfig({
    bucket: 'video-1250000000',
    region: 'ap-chengdu',
    desktopPrefix: '../updates',
  }, { requireCredentials: false }), /无效的上传目录/)
})

test('release targets can publish desktop and runtime independently', () => {
  assert.deepEqual(releaseTargets([]), { desktop: true, runtime: true })
  assert.deepEqual(releaseTargets(['--desktop']), { desktop: true, runtime: false })
  assert.deepEqual(releaseTargets(['--runtime']), { desktop: false, runtime: true })
  assert.deepEqual(releaseTargets(['--desktop', '--runtime']), { desktop: true, runtime: true })
})

test('desktop COS publishing excludes the local offline zip', () => {
  assert.deepEqual(desktopReleaseFileNames('0.4.5'), [
    'VideoAutoCutStudioUserSetup-x64-0.4.5.exe',
    'VideoAutoCutStudioUserSetup-x64-0.4.5.exe.blockmap',
    'desktop-config.enc.json',
  ])
})
