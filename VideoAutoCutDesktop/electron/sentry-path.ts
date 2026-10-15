import path from 'node:path'

/** Keep existing index identities for short paths; make long file arguments readable by embedded Python. */
export function sentryFilePath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return value
  const resolved = path.win32.resolve(value)
  if (resolved.startsWith('\\\\?\\') || resolved.length < 260) return value
  return path.win32.toNamespacedPath(resolved)
}

/** The desktop captures UTF-8; Python otherwise emits Chinese diagnostics in the Windows code page. */
export function sentryProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PYTHONIOENCODING: 'utf-8' }
}
