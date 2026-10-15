import fs from 'node:fs'

function cleanConfiguredPath(value: unknown): string {
  return String(value || '').trim().replace(/^["']|["']$/g, '')
}

function ensureDir(dir: string): void {
  if (!dir) return
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function firstConfiguredValue(keys: readonly string[], env: Record<string, string | undefined> = {}): string {
  for (const key of keys) {
    const value = process.env[key] || env[key]
    if (String(value || '').trim()) return String(value)
  }
  return ''
}

function firstCleanValue(...values: unknown[]): string {
  for (const value of values) {
    const text = cleanConfiguredPath(value)
    if (text) return text
  }
  return ''
}

function parseBooleanEnvValue(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const text = value.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  return null
}

function safeJsonRead<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (_error) {
    return fallback
  }
}

export {
  cleanConfiguredPath,
  ensureDir,
  firstCleanValue,
  firstConfiguredValue,
  parseBooleanEnvValue,
  safeJsonRead,
}
