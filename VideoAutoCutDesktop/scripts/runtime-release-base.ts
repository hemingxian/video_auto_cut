import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import * as yauzl from 'yauzl'

interface RuntimeBaseManifestItem {
  version?: unknown
  url?: unknown
  sha256?: unknown
  size?: unknown
}

interface RuntimeBaseManifest {
  latest?: unknown
  versions?: unknown
}

interface RuntimeBaseRelease {
  version: string
  url: string
  sha256: string
  size: number
}

interface PrepareRuntimeBaseOptions {
  cacheRoot: string
  engineExeName: string
  manifestUrl: string
}

function clean(value: unknown): string {
  return String(value || '').trim()
}

function runtimeRoot(baseDir: string, engineExeName: string): string {
  for (const candidate of [baseDir, path.join(baseDir, 'VideoAutoCut')]) {
    if (fs.existsSync(path.join(candidate, engineExeName))) return candidate
  }
  return ''
}

function parseRuntimeBaseManifest(value: RuntimeBaseManifest, manifestUrl: string): RuntimeBaseRelease {
  const latest = clean(value.latest)
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(latest) || latest.includes('..')) {
    throw new Error('基础运行环境清单缺少安全的 latest 版本号')
  }

  const versions = Array.isArray(value.versions) ? value.versions as RuntimeBaseManifestItem[] : []
  const current = versions.find((item) => clean(item.version) === latest)
  if (!current) throw new Error(`基础运行环境清单没有 latest=${latest} 对应的版本`)

  const resolvedUrl = new URL(clean(current.url), manifestUrl)
  if (resolvedUrl.protocol !== 'https:') throw new Error('基础运行环境下载地址必须使用 HTTPS')

  const sha256 = clean(current.sha256).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('基础运行环境清单缺少有效的 SHA-256')

  const size = Number(current.size)
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('基础运行环境清单缺少有效的文件大小')

  return { version: latest, url: resolvedUrl.href, sha256, size }
}

function safeRuntimeZipTarget(destination: string, entryName: string): string {
  const normalizedName = entryName.replace(/\\/g, '/')
  if (!normalizedName || normalizedName.startsWith('/') || /^[a-zA-Z]:/.test(normalizedName)) {
    throw new Error(`基础运行环境包含不安全路径：${entryName}`)
  }

  const parts = normalizedName.split('/').filter(Boolean)
  if (parts.includes('..')) throw new Error(`基础运行环境包含不安全路径：${entryName}`)

  const destinationFull = path.resolve(destination)
  const target = path.resolve(destinationFull, ...parts)
  const relative = path.relative(destinationFull, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`基础运行环境包含不安全路径：${entryName}`)
  }
  return target
}

function requestHttps(url: string, redirects = 0): Promise<import('node:http').IncomingMessage> {
  if (redirects > 5) return Promise.reject(new Error('基础运行环境下载重定向次数过多'))
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') return Promise.reject(new Error('基础运行环境下载地址必须使用 HTTPS'))

  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers: { 'User-Agent': 'VideoAutoCut-Release' } }, (response) => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        const next = new URL(response.headers.location, parsed).href
        requestHttps(next, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`基础运行环境下载失败：HTTP ${status}`))
        return
      }
      resolve(response)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('基础运行环境下载连接超时')))
    request.on('error', reject)
  })
}

async function readHttpsJson(url: string): Promise<RuntimeBaseManifest> {
  const response = await requestHttps(url)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1024 * 1024) throw new Error('基础运行环境清单过大')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RuntimeBaseManifest
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function isValidArchive(filePath: string, release: RuntimeBaseRelease): Promise<boolean> {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== release.size) return false
  return await sha256File(filePath) === release.sha256
}

async function downloadArchive(release: RuntimeBaseRelease, archivePath: string): Promise<void> {
  const temporaryPath = `${archivePath}.part`
  fs.rmSync(temporaryPath, { force: true })
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  const response = await requestHttps(release.url)
  const advertisedSize = Number(response.headers['content-length'] || 0)
  if (advertisedSize && advertisedSize !== release.size) {
    response.resume()
    throw new Error(`基础运行环境远端大小不一致：清单 ${release.size}，响应 ${advertisedSize}`)
  }

  let transferred = 0
  let lastPercent = -1
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length
      const percent = Math.min(100, Math.floor(transferred / release.size * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        process.stdout.write(`\r[发布] 下载基础运行环境 ${percent.toString().padStart(3)}%`)
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(response, progress, fs.createWriteStream(temporaryPath))
    process.stdout.write('\n')
    if (!await isValidArchive(temporaryPath, release)) throw new Error('基础运行环境下载后校验失败')
    fs.rmSync(archivePath, { force: true })
    fs.renameSync(temporaryPath, archivePath)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const zipFile = await yauzl.openPromise(archivePath, {
    autoClose: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })
  try {
    for await (const entry of zipFile.eachEntry()) {
      const target = safeRuntimeZipTarget(destination, entry.fileName)
      if (entry.fileName.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true })
        continue
      }
      if (!entry.canDecodeFileData() || entry.isEncrypted()) {
        throw new Error(`基础运行环境包含不支持的文件：${entry.fileName}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await pipeline(await zipFile.openReadStreamPromise(entry), fs.createWriteStream(target))
    }
  } finally {
    zipFile.close()
  }
}

async function prepareRuntimeBase(options: PrepareRuntimeBaseOptions): Promise<string> {
  const manifest = await readHttpsJson(options.manifestUrl)
  const release = parseRuntimeBaseManifest(manifest, options.manifestUrl)
  const versionRoot = path.join(options.cacheRoot, release.version)
  const completionMarker = path.join(versionRoot, '.release-cache-complete.json')
  let cachedRelease: Partial<RuntimeBaseRelease> | null = null
  try {
    if (fs.existsSync(completionMarker)) {
      cachedRelease = JSON.parse(fs.readFileSync(completionMarker, 'utf8')) as Partial<RuntimeBaseRelease>
    }
  } catch {
    cachedRelease = null
  }
  const existing = cachedRelease?.sha256 === release.sha256
    ? runtimeRoot(versionRoot, options.engineExeName)
    : ''
  if (existing) {
    console.log(`[发布] 复用基础运行环境缓存：${release.version}`)
    return existing
  }

  const archivePath = path.join(options.cacheRoot, 'downloads', `VideoAutoCut-runtime-${release.version}.zip`)
  if (!await isValidArchive(archivePath, release)) {
    console.log(`[发布] 本机没有完整运行环境，下载云端版本 ${release.version} 作为打包基础`)
    await downloadArchive(release, archivePath)
  }

  fs.rmSync(versionRoot, { recursive: true, force: true })
  fs.mkdirSync(versionRoot, { recursive: true })
  try {
    console.log(`[发布] 解压基础运行环境：${release.version}`)
    await extractArchive(archivePath, versionRoot)
    const extracted = runtimeRoot(versionRoot, options.engineExeName)
    if (!extracted) throw new Error(`基础运行环境压缩包缺少 ${options.engineExeName}`)
    fs.writeFileSync(completionMarker, `${JSON.stringify(release, null, 2)}\n`, 'utf8')
  } catch (error) {
    fs.rmSync(versionRoot, { recursive: true, force: true })
    throw error
  }

  const prepared = runtimeRoot(versionRoot, options.engineExeName)
  if (!prepared) throw new Error('基础运行环境缓存创建失败')
  return prepared
}

export {
  parseRuntimeBaseManifest,
  prepareRuntimeBase,
  safeRuntimeZipTarget,
}

export type { RuntimeBaseManifest, RuntimeBaseRelease }
