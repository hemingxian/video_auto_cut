import fs from 'node:fs'
import path from 'node:path'

interface ReleaseUploadConfigFile {
  secretId?: unknown
  secretKey?: unknown
  sessionToken?: unknown
  bucket?: unknown
  region?: unknown
  publicBaseUrl?: unknown
  desktopPrefix?: unknown
  runtimePrefix?: unknown
}

interface ReleaseUploadConfig {
  secretId: string
  secretKey: string
  sessionToken: string
  bucket: string
  region: string
  publicBaseUrl: string
  desktopPrefix: string
  runtimePrefix: string
}

interface ReleasePublicUrls {
  desktop: string
  runtime: string
}

interface ReleaseTargets {
  desktop: boolean
  runtime: boolean
}

const CONFIG_FILE_NAME = 'release-upload.local.json'

function clean(value: unknown): string {
  return String(value || '').trim()
}

function normalizeBaseUrl(value: unknown): string {
  const url = clean(value).replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) throw new Error('publicBaseUrl 必须以 http:// 或 https:// 开头')
  return url
}

function normalizePrefix(value: unknown, fallback: string): string {
  const prefix = clean(value || fallback).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!prefix) return ''
  const parts = prefix.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`无效的上传目录：${prefix}`)
  }
  return parts.join('/')
}

function joinUrl(baseUrl: string, prefix: string): string {
  return prefix ? `${baseUrl.replace(/\/+$/, '')}/${prefix}` : baseUrl.replace(/\/+$/, '')
}

function releasePublicUrls(config: ReleaseUploadConfig): ReleasePublicUrls {
  return {
    desktop: joinUrl(config.publicBaseUrl, config.desktopPrefix),
    runtime: joinUrl(config.publicBaseUrl, config.runtimePrefix),
  }
}

function releaseTargets(args: readonly string[]): ReleaseTargets {
  const desktop = args.includes('--desktop')
  const runtime = args.includes('--runtime')
  if (!desktop && !runtime) return { desktop: true, runtime: true }
  return { desktop, runtime }
}

function parseReleaseUploadConfig(
  value: ReleaseUploadConfigFile,
  options: { requireCredentials?: boolean } = {},
): ReleaseUploadConfig {
  const secretId = clean(value.secretId)
  const secretKey = clean(value.secretKey)
  const sessionToken = clean(value.sessionToken)
  const bucket = clean(value.bucket)
  const region = clean(value.region)
  const publicBaseUrl = normalizeBaseUrl(value.publicBaseUrl)
    || (bucket && region ? `https://${bucket}.cos.${region}.myqcloud.com` : '')

  const missing = [
    ['bucket', bucket],
    ['region', region],
    ['publicBaseUrl', publicBaseUrl],
  ].filter(([, item]) => !item).map(([name]) => name)

  if (options.requireCredentials !== false) {
    if (!secretId) missing.push('secretId')
    if (!secretKey) missing.push('secretKey')
  }
  if (missing.length) throw new Error(`发布配置缺少：${missing.join('、')}`)

  return {
    secretId,
    secretKey,
    sessionToken,
    bucket,
    region,
    publicBaseUrl,
    desktopPrefix: normalizePrefix(value.desktopPrefix, 'updates'),
    runtimePrefix: normalizePrefix(value.runtimePrefix, 'runtime'),
  }
}

function loadReleaseUploadConfig(
  desktopRoot: string,
  options: { requireCredentials?: boolean } = {},
): ReleaseUploadConfig {
  const configPath = path.join(desktopRoot, CONFIG_FILE_NAME)
  if (!fs.existsSync(configPath)) {
    throw new Error(`没有找到本地发布配置：${configPath}`)
  }

  let value: ReleaseUploadConfigFile
  try {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReleaseUploadConfigFile
  } catch (error) {
    throw new Error(`本地发布配置不是有效 JSON：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return parseReleaseUploadConfig(value, options)
}

function objectKey(prefix: string, fileName: string): string {
  return prefix ? `${prefix}/${fileName}` : fileName
}

function desktopReleaseFileNames(version: string): string[] {
  return [
    `VideoAutoCutStudioUserSetup-x64-${version}.exe`,
    `VideoAutoCutStudioUserSetup-x64-${version}.exe.blockmap`,
    'desktop-config.enc.json',
  ]
}

export {
  CONFIG_FILE_NAME,
  desktopReleaseFileNames,
  joinUrl,
  loadReleaseUploadConfig,
  objectKey,
  parseReleaseUploadConfig,
  releasePublicUrls,
  releaseTargets,
}
export type { ReleasePublicUrls, ReleaseTargets, ReleaseUploadConfig, ReleaseUploadConfigFile }
