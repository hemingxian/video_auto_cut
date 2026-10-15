import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir } from './utils.js'

function validDeviceId(value: unknown): string {
  const deviceId = String(value || '').trim()
  return /^dev_[a-f0-9]{32}$/.test(deviceId) ? deviceId : ''
}

function getOrCreateDeviceId(filePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { deviceId?: unknown }
    const existing = validDeviceId(parsed.deviceId)
    if (existing) return existing
  } catch {
    // A missing or damaged identity file is replaced with a fresh opaque ID.
  }

  const deviceId = `dev_${randomUUID().replaceAll('-', '')}`
  ensureDir(path.dirname(filePath))
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporaryPath, JSON.stringify({ deviceId }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  fs.renameSync(temporaryPath, filePath)
  return deviceId
}

export {
  getOrCreateDeviceId,
}
