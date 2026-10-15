import crypto from 'node:crypto'
import fs from 'node:fs'

import { httpJson } from './http.js'
import { extractRemoteEnv, withoutGatewayCredentials } from './managed-config.js'
import { asRecord, numberValue, stringValue, type EnvReader, type JsonRecord } from './types.js'
import { cleanConfiguredPath, firstConfiguredValue } from './utils.js'

interface RemoteConfigServiceOptions {
  readEnv: EnvReader
  writeRemoteEnv: (updates: Record<string, unknown>) => unknown
  defaultsPath?: string
}

const REMOTE_CONFIG_URL_KEYS = [
  'VIDEOAUTO_REMOTE_CONFIG_URL',
  'VIDEOAUTOCUT_REMOTE_CONFIG_URL',
] as const

const REMOTE_CONFIG_SECRET_KEYS = [
  'VIDEOAUTO_REMOTE_CONFIG_SECRET',
  'VIDEOAUTOCUT_REMOTE_CONFIG_SECRET',
  'VIDEOAUTO_REMOTE_CONFIG_KEY',
  'VIDEOAUTOCUT_REMOTE_CONFIG_KEY',
] as const

function decodeBase64Url(text: string): Buffer {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

function decodeBinaryField(value: unknown, fieldName: string, encoding: unknown): Buffer {
  const text = cleanConfiguredPath(value)
  if (!text) throw new Error(`Remote config missing ${fieldName}`)

  const normalizedEncoding = cleanConfiguredPath(encoding).toLowerCase()
  if (normalizedEncoding === 'hex') return Buffer.from(text, 'hex')
  return decodeBase64Url(text)
}

function deriveAesKey(secret: string, payload: JsonRecord): Buffer {
  const kdf = cleanConfiguredPath(payload.kdf).toLowerCase() || 'sha256'
  if (kdf === 'pbkdf2') {
    const salt = decodeBinaryField(payload.salt, 'salt', payload.encoding)
    const iterations = Math.max(10000, numberValue(payload.iterations, 120000))
    return crypto.pbkdf2Sync(secret, salt, iterations, 32, 'sha256')
  }

  return crypto.createHash('sha256').update(secret, 'utf8').digest()
}

function decryptRemoteConfig(payload: JsonRecord, secret: string): JsonRecord {
  const encoding = payload.encoding
  const encrypted = decodeBinaryField(payload.data || payload.ciphertext, 'data', encoding)
  const iv = decodeBinaryField(payload.iv || payload.nonce, 'iv', encoding)
  const tag = decodeBinaryField(payload.tag || payload.authTag, 'tag', encoding)
  const key = deriveAesKey(secret, payload)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)

  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  return asRecord(JSON.parse(plaintext))
}

function isEncryptedPayload(payload: JsonRecord): boolean {
  return Boolean(payload.data || payload.ciphertext) && Boolean(payload.iv || payload.nonce) && Boolean(payload.tag || payload.authTag)
}

function readRemoteConfigDefaults(file: string | undefined): JsonRecord {
  if (!file || !fs.existsSync(file)) return {}

  try {
    return asRecord(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    console.warn('[remote-config] defaults ignored', stringValue(asRecord(error).message || error))
    return {}
  }
}

function createRemoteConfigService(options: RemoteConfigServiceOptions) {
  const { readEnv, writeRemoteEnv } = options
  const defaults = readRemoteConfigDefaults(options.defaultsPath)

  async function syncOnce() {
    const env = readEnv()
    const url = cleanConfiguredPath(firstConfiguredValue(REMOTE_CONFIG_URL_KEYS, env)) || cleanConfiguredPath(defaults.url)
    if (!url) return { ok: true, skipped: true, reason: 'missing-url' }

    try {
      const payload = await httpJson(url, { timeoutMs: 15000 })
      const secret = cleanConfiguredPath(firstConfiguredValue(REMOTE_CONFIG_SECRET_KEYS, env)) || cleanConfiguredPath(defaults.secret)
      if (isEncryptedPayload(payload) && !secret) throw new Error('Remote config secret is missing')
      const configPayload = isEncryptedPayload(payload)
        ? decryptRemoteConfig(payload, secret)
        : payload
      // Gateway credentials are provisioned from the signed-in account token only.
      const remoteEnv = withoutGatewayCredentials(extractRemoteEnv(configPayload))
      const keys = Object.keys(remoteEnv)

      if (!keys.length) return { ok: true, skipped: true, reason: 'empty-config' }
      writeRemoteEnv(remoteEnv)
      console.info('[remote-config] synced', { keys })
      return { ok: true, skipped: false, keys }
    } catch (error) {
      console.warn('[remote-config] sync failed', stringValue(asRecord(error).message || error))
      return { ok: false, skipped: true, reason: 'sync-failed' }
    }
  }

  return {
    syncOnce,
  }
}

export {
  createRemoteConfigService,
}
