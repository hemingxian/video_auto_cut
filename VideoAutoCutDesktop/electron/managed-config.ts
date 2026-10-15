import { asRecord } from './types.js'
import { cleanConfiguredPath } from './utils.js'
import { REMOTE_MANAGED_ENV_KEYS, REMOTE_SECRET_ENV_KEYS } from './managed-env-keys.js'

const REMOTE_MANAGED_ENV_KEY_SET = new Set<string>(REMOTE_MANAGED_ENV_KEYS)
const REMOTE_SECRET_ENV_KEY_SET = new Set<string>(REMOTE_SECRET_ENV_KEYS)
const GATEWAY_CREDENTIAL_ENV_KEYS = ['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL'] as const

const REMOTE_CONFIG_CONTAINER_KEYS = new Set([
  'api_keys',
  'apiKeys',
  'config',
  'configs',
  'desktop_config',
  'desktopConfig',
  'env',
  'runtime_config',
  'runtimeConfig',
  'settings',
  'video_auto_config',
  'videoAutoConfig',
  'video_auto_cut_config',
  'videoAutoCutConfig',
])

const REMOTE_CONFIG_ALIASES: Record<string, string> = {
  ALIYUN_DASHSCOPE_API_KEY: 'DASHSCOPE_API_KEY',
  DASHSCOPE: 'DASHSCOPE_API_KEY',
  DASHSCOPE_KEY: 'DASHSCOPE_API_KEY',
  QWEN_API_KEY: 'DASHSCOPE_API_KEY',
  PEXELS: 'PEXELS_API_KEY',
  PEXELS_KEY: 'PEXELS_API_KEY',
  PIXABAY: 'PIXABAY_API_KEY',
  PIXABAY_KEY: 'PIXABAY_API_KEY',
  JAMENDO: 'JAMENDO_CLIENT_ID',
  JAMENDO_KEY: 'JAMENDO_CLIENT_ID',
  JAMENDO_CLIENT: 'JAMENDO_CLIENT_ID',
  OPENVERSE_CLIENT: 'OPENVERSE_CLIENT_ID',
  OPENVERSE_ID: 'OPENVERSE_CLIENT_ID',
  OPENVERSE_SECRET: 'OPENVERSE_CLIENT_SECRET',
  OPENVERSE_KEY: 'OPENVERSE_CLIENT_SECRET',
}

type EnvRecord = Record<string, string>

function normalizeRemoteConfigKey(key: string): string {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^0-9A-Za-z]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return REMOTE_CONFIG_ALIASES[normalized] || normalized
}

function isManagedEnvKey(key: string): boolean {
  return REMOTE_MANAGED_ENV_KEY_SET.has(key)
}

function isRemoteConfigContainer(key: string): boolean {
  return REMOTE_CONFIG_CONTAINER_KEYS.has(key)
}

function cleanRemoteConfigValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return cleanConfiguredPath(value)
}

function extractRemoteEnv(payload: unknown): EnvRecord {
  const env: EnvRecord = {}
  const seen = new Set<unknown>()

  function visit(value: unknown, depth: number, insideConfig: boolean): void {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return
    seen.add(value)

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, insideConfig)
      return
    }

    const record = asRecord(value)
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = normalizeRemoteConfigKey(rawKey)
      if ((insideConfig || isManagedEnvKey(key)) && isManagedEnvKey(key)) {
        const cleanValue = cleanRemoteConfigValue(rawValue)
        if (cleanValue) env[key] = cleanValue
        continue
      }

      const nextInsideConfig = insideConfig || isRemoteConfigContainer(rawKey)
      if (rawValue && typeof rawValue === 'object') visit(rawValue, depth + 1, nextInsideConfig)
    }
  }

  visit(payload, 0, false)
  return env
}

function filterWritableEnvUpdates(updates: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(updates)) {
    if (REMOTE_SECRET_ENV_KEY_SET.has(key)) continue
    filtered[key] = value
  }
  return filtered
}

function coerceRemoteEnv(value: unknown): EnvRecord {
  const record = asRecord(value)
  const env: EnvRecord = {}
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeRemoteConfigKey(rawKey)
    if (!isManagedEnvKey(key)) continue
    const cleanValue = cleanRemoteConfigValue(rawValue)
    if (cleanValue) env[key] = cleanValue
  }
  return env
}

function withoutGatewayCredentials(value: unknown): EnvRecord {
  const env = coerceRemoteEnv(value)
  for (const key of GATEWAY_CREDENTIAL_ENV_KEYS) delete env[key]
  return env
}

export {
  GATEWAY_CREDENTIAL_ENV_KEYS,
  REMOTE_MANAGED_ENV_KEYS,
  REMOTE_SECRET_ENV_KEYS,
  coerceRemoteEnv,
  extractRemoteEnv,
  filterWritableEnvUpdates,
  withoutGatewayCredentials,
}
