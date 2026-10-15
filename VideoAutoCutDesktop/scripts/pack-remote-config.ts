import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseDotenv } from 'dotenv'

interface PackageInfo {
  version?: string
  build?: {
    publish?: Array<{ url?: string }>
  }
}

interface EncryptedRemoteConfig {
  version: number
  alg: 'aes-256-gcm'
  kdf: 'pbkdf2'
  iterations: number
  encoding: 'base64'
  salt: string
  iv: string
  tag: string
  data: string
}

interface ManagedConfigModule {
  coerceRemoteEnv: (value: unknown) => Record<string, string>
}

interface RemoteConfigDefaults {
  version?: number
  url?: string
  secret?: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const packageJsonPath = path.join(desktopRoot, 'package.json')
const packageInfo = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageInfo
const outputName = process.env.VIDEOAUTO_REMOTE_CONFIG_OUTPUT_NAME || 'desktop-config.enc.json'
const distElectronDir = path.join(desktopRoot, 'dist-electron')
const defaultsPath = path.join(distElectronDir, 'remote-config-defaults.json')
const releaseDir = path.join(desktopRoot, 'release')
const artifactPath = path.join(releaseDir, outputName)
const args = new Set(process.argv.slice(2))
const cleanupOnly = args.has('--cleanup')
const writeDefaults = !args.has('--artifact-only')
const writeArtifact = !args.has('--defaults-only')

if (cleanupOnly) {
  fs.rmSync(defaultsPath, { force: true })
  console.log(`remote config defaults cleaned: ${defaultsPath}`)
  process.exit(0)
}

function clean(value: unknown): string {
  return String(value || '').trim().replace(/^["']|["']$/g, '')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {}
  return parseDotenv(fs.readFileSync(file, 'utf8'))
}

function readJsonOrEnvFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  if (path.extname(file).toLowerCase() !== '.json') return readEnvFile(file)
  return asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function readDefaultsFile(): RemoteConfigDefaults {
  if (!fs.existsSync(defaultsPath)) return {}
  return JSON.parse(fs.readFileSync(defaultsPath, 'utf8')) as RemoteConfigDefaults
}

function firstValue(keys: readonly string[], ...records: Array<Record<string, unknown>>): string {
  for (const record of records) {
    for (const key of keys) {
      const value = clean(record[key])
      if (value) return value
    }
  }
  return ''
}

function defaultRemoteConfigUrl(): string {
  const publish = Array.isArray(packageInfo.build?.publish) ? packageInfo.build.publish[0] : null
  const baseUrl = clean(process.env.VIDEOAUTO_REMOTE_CONFIG_BASE_URL || publish?.url)
  if (!baseUrl) return ''
  return `${baseUrl.replace(/\/+$/, '')}/${outputName}`
}

async function loadManagedConfig(): Promise<ManagedConfigModule> {
  const modulePath = path.join(distElectronDir, 'managed-config.js')
  if (!fs.existsSync(modulePath)) {
    throw new Error('Missing dist-electron/managed-config.js. Run npm run build before packing remote config.')
  }
  return import(pathToFileURL(modulePath).href) as Promise<ManagedConfigModule>
}

function encryptPayload(payload: Record<string, unknown>, secret: string): EncryptedRemoteConfig {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.pbkdf2Sync(secret, salt, 120000, 32, 'sha256')
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])

  return {
    version: 1,
    alg: 'aes-256-gcm',
    kdf: 'pbkdf2',
    iterations: 120000,
    encoding: 'base64',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

const sourcePath = path.resolve(desktopRoot, clean(process.env.VIDEOAUTO_REMOTE_CONFIG_SOURCE) || path.join('..', 'VideoAutoCut', '.env'))
const sourceConfig = readJsonOrEnvFile(sourcePath)
const mergedConfig: Record<string, unknown> = { ...sourceConfig, ...process.env }
const existingDefaults = readDefaultsFile()
const configuredSecret = firstValue([
  'VIDEOAUTO_REMOTE_CONFIG_SECRET',
  'VIDEOAUTOCUT_REMOTE_CONFIG_SECRET',
  'VIDEOAUTO_REMOTE_CONFIG_KEY',
  'VIDEOAUTOCUT_REMOTE_CONFIG_KEY',
], mergedConfig)
const secret = configuredSecret || clean(existingDefaults.secret) || crypto.randomBytes(32).toString('base64url')
const url = firstValue([
  'VIDEOAUTO_REMOTE_CONFIG_URL',
  'VIDEOAUTOCUT_REMOTE_CONFIG_URL',
], mergedConfig) || clean(existingDefaults.url) || defaultRemoteConfigUrl()

if (!url) {
  console.error('Missing VIDEOAUTO_REMOTE_CONFIG_URL and no package publish URL is configured.')
  process.exit(1)
}

const { coerceRemoteEnv } = await loadManagedConfig()
const remoteEnv = coerceRemoteEnv(mergedConfig)
const keys = Object.keys(remoteEnv)

if (writeArtifact && !keys.length) {
  console.error(`No managed remote config keys found in ${sourcePath}.`)
  process.exit(1)
}

if (writeDefaults) {
  fs.mkdirSync(distElectronDir, { recursive: true })
  fs.writeFileSync(defaultsPath, `${JSON.stringify({ version: 1, url, secret }, null, 2)}\n`, 'utf8')
  console.log(`remote config defaults: ${defaultsPath}`)
}

if (writeArtifact) {
  fs.mkdirSync(releaseDir, { recursive: true })
  const encrypted = encryptPayload({
    version: 1,
    generatedAt: new Date().toISOString(),
    appVersion: clean(packageInfo.version),
    env: remoteEnv,
  }, secret)
  fs.writeFileSync(artifactPath, `${JSON.stringify(encrypted, null, 2)}\n`, 'utf8')
  console.log(`remote config artifact: ${artifactPath}`)
  console.log(`remote config url: ${url}`)
  console.log(`remote config keys: ${keys.join(', ')}`)
}
