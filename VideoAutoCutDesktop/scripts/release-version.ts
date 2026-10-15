import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface PackageRecord {
  version?: unknown
  packages?: Record<string, PackageRecord>
}

interface RuntimeManifest {
  latest?: unknown
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function clean(value: unknown): string {
  return String(value || '').trim()
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assertReleaseVersion(value: unknown): string {
  const version = clean(value)
  if (!semverPattern.test(version)) {
    throw new Error(`版本号格式不正确：${version || '(empty)'}，示例：0.4.6`)
  }
  return version
}

function currentDesktopVersion(root = desktopRoot): string {
  return assertReleaseVersion(readJson<PackageRecord>(path.join(root, 'package.json')).version)
}

function currentRuntimeVersion(root = desktopRoot): string {
  const manifestPath = path.join(root, 'runtime-release', 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    const version = clean(readJson<RuntimeManifest>(manifestPath).latest)
    if (semverPattern.test(version)) return version
  }
  return currentDesktopVersion(root)
}

function setDesktopVersion(root: string, value: unknown): string {
  const version = assertReleaseVersion(value)
  const packagePath = path.join(root, 'package.json')
  const packageInfo = readJson<PackageRecord>(packagePath)
  packageInfo.version = version
  writeJson(packagePath, packageInfo)

  const lockPath = path.join(root, 'package-lock.json')
  if (fs.existsSync(lockPath)) {
    const lock = readJson<PackageRecord>(lockPath)
    lock.version = version
    if (lock.packages?.['']) lock.packages[''].version = version
    writeJson(lockPath, lock)
  }
  return version
}

function main(args: string[]): void {
  const [command, value] = args
  if (command === 'current-desktop') {
    console.log(currentDesktopVersion())
    return
  }
  if (command === 'current-runtime') {
    console.log(currentRuntimeVersion())
    return
  }
  if (command === 'set-desktop') {
    console.log(setDesktopVersion(desktopRoot, value))
    return
  }
  if (command === 'validate') {
    console.log(assertReleaseVersion(value))
    return
  }
  throw new Error('未知的版本号操作')
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (entry === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[版本号错误] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export { assertReleaseVersion, currentDesktopVersion, currentRuntimeVersion, setDesktopVersion }
