import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import COS from 'cos-nodejs-sdk-v5'

import { desktopReleaseFileNames, loadReleaseUploadConfig, objectKey, releasePublicUrls, releaseTargets } from './release-upload-config.js'

interface PackageInfo {
  version?: string
}

interface RuntimeManifestItem {
  version?: unknown
  url?: unknown
  sha256?: unknown
  size?: unknown
  notes?: unknown
}

interface RuntimeManifest {
  latest?: unknown
  versions?: unknown
}

interface UploadArtifact {
  group: '桌面壳' | '视频生成引擎'
  filePath: string
  key: string
  cacheControl: string
  contentType: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(desktopRoot, 'release')
const runtimeReleaseDir = path.join(desktopRoot, 'runtime-release')

function clean(value: unknown): string {
  return String(value || '').trim()
}

function requireFile(filePath: string): fs.Stats {
  if (!fs.existsSync(filePath)) throw new Error(`缺少发布文件：${filePath}`)
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size <= 0) throw new Error(`发布文件为空或不是文件：${filePath}`)
  return stat
}

function contentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase()
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.yml' || extension === '.yaml') return 'text/yaml; charset=utf-8'
  if (extension === '.zip') return 'application/zip'
  if (extension === '.exe') return 'application/vnd.microsoft.portable-executable'
  return 'application/octet-stream'
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function desktopArtifacts(version: string, desktopPrefix: string): { files: UploadArtifact[], marker: UploadArtifact } {
  const names = desktopReleaseFileNames(version)
  const files = names.map((name): UploadArtifact => ({
    group: '桌面壳',
    filePath: path.join(releaseDir, name),
    key: objectKey(desktopPrefix, name),
    cacheControl: name === 'desktop-config.enc.json'
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=31536000, immutable',
    contentType: contentType(name),
  }))
  const markerName = 'latest.yml'
  return {
    files,
    marker: {
      group: '桌面壳',
      filePath: path.join(releaseDir, markerName),
      key: objectKey(desktopPrefix, markerName),
      cacheControl: 'no-cache, no-store, must-revalidate',
      contentType: contentType(markerName),
    },
  }
}

async function runtimeArtifacts(runtimePrefix: string, runtimePublicUrl: string): Promise<{ files: UploadArtifact[], marker: UploadArtifact }> {
  const manifestPath = path.join(runtimeReleaseDir, 'manifest.json')
  requireFile(manifestPath)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifest
  const latest = clean(manifest.latest)
  const versions = Array.isArray(manifest.versions) ? manifest.versions as RuntimeManifestItem[] : []
  const current = versions.find((item) => clean(item.version) === latest)
  if (!latest || !current) throw new Error('视频生成引擎 manifest.json 缺少 latest 对应的版本信息')

  const zipName = `VideoAutoCut-runtime-${latest}.zip`
  const zipPath = path.join(runtimeReleaseDir, zipName)
  const zipStat = requireFile(zipPath)
  const actualSha256 = await sha256File(zipPath)
  const manifestSha256 = clean(current.sha256).toLowerCase()
  if (manifestSha256 && manifestSha256 !== actualSha256) {
    throw new Error(`视频生成引擎 SHA-256 不一致：manifest=${manifestSha256}，文件=${actualSha256}`)
  }
  const manifestSize = Number(current.size || 0)
  if (manifestSize && manifestSize !== zipStat.size) {
    throw new Error(`视频生成引擎文件大小不一致：manifest=${manifestSize}，文件=${zipStat.size}`)
  }

  current.url = `${runtimePublicUrl.replace(/\/+$/, '')}/${zipName}`
  current.sha256 = actualSha256
  current.size = zipStat.size
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return {
    files: [{
      group: '视频生成引擎',
      filePath: zipPath,
      key: objectKey(runtimePrefix, zipName),
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: contentType(zipName),
    }],
    marker: {
      group: '视频生成引擎',
      filePath: manifestPath,
      key: objectKey(runtimePrefix, 'manifest.json'),
      cacheControl: 'no-cache, no-store, must-revalidate',
      contentType: contentType('manifest.json'),
    },
  }
}

function validateDesktopRelease(version: string, artifacts: { files: UploadArtifact[], marker: UploadArtifact }): void {
  for (const artifact of [...artifacts.files, artifacts.marker]) requireFile(artifact.filePath)
  const latest = fs.readFileSync(artifacts.marker.filePath, 'utf8')
  const installer = `VideoAutoCutStudioUserSetup-x64-${version}.exe`
  if (!new RegExp(`^version:\\s*['"]?${version.replace(/\./g, '\\.')}['"]?\\s*$`, 'm').test(latest)) {
    throw new Error(`latest.yml 的版本不是 ${version}`)
  }
  if (!latest.includes(installer)) throw new Error(`latest.yml 没有引用 ${installer}`)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

async function uploadArtifact(cos: COS, bucket: string, region: string, artifact: UploadArtifact): Promise<void> {
  const stat = requireFile(artifact.filePath)
  let lastPercent = -1
  console.log(`\n[上传] ${artifact.group}：${path.basename(artifact.filePath)} (${formatBytes(stat.size)})`)
  await cos.uploadFile({
    Bucket: bucket,
    Region: region,
    Key: artifact.key,
    FilePath: artifact.filePath,
    SliceSize: 5 * 1024 * 1024,
    ChunkSize: 8 * 1024 * 1024,
    CacheControl: artifact.cacheControl,
    ContentType: artifact.contentType,
    onProgress: ({ percent, speed }) => {
      const nextPercent = Math.floor(percent * 100)
      if (nextPercent === lastPercent && nextPercent !== 100) return
      lastPercent = nextPercent
      process.stdout.write(`\r[上传] ${nextPercent.toString().padStart(3)}%  ${formatBytes(speed)}/s`)
      if (nextPercent === 100) process.stdout.write('\n')
    },
  })

  const remote = await cos.headObject({ Bucket: bucket, Region: region, Key: artifact.key })
  const remoteSize = Number(remote.headers?.['content-length'] || 0)
  if (remoteSize && remoteSize !== stat.size) {
    throw new Error(`上传后大小校验失败：${artifact.key}，本地 ${stat.size}，远端 ${remoteSize}`)
  }
  console.log(`[完成] cos://${bucket}/${artifact.key}`)
}

async function main(): Promise<void> {
  const targets = releaseTargets(process.argv.slice(2))
  const config = loadReleaseUploadConfig(desktopRoot)
  const urls = releasePublicUrls(config)
  let desktop: ReturnType<typeof desktopArtifacts> | null = null
  let runtime: Awaited<ReturnType<typeof runtimeArtifacts>> | null = null

  if (targets.desktop) {
    const packageInfo = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as PackageInfo
    const version = clean(packageInfo.version)
    if (!version) throw new Error('package.json 缺少版本号')
    desktop = desktopArtifacts(version, config.desktopPrefix)
    validateDesktopRelease(version, desktop)
  }
  if (targets.runtime) runtime = await runtimeArtifacts(config.runtimePrefix, urls.runtime)

  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    SecurityToken: config.sessionToken || undefined,
    ChunkRetryTimes: 3,
    ChunkParallelLimit: 3,
    FileParallelLimit: 1,
    Timeout: 120000,
  })

  console.log(`[发布] COS：${config.bucket} / ${config.region}`)
  if (desktop) console.log(`[发布] 桌面壳：${urls.desktop}`)
  if (runtime) console.log(`[发布] 视频生成引擎：${urls.runtime}`)

  const files = [...(runtime?.files || []), ...(desktop?.files || [])]
  for (const artifact of files) {
    await uploadArtifact(cos, config.bucket, config.region, artifact)
  }

  if (runtime) await uploadArtifact(cos, config.bucket, config.region, runtime.marker)
  if (desktop) await uploadArtifact(cos, config.bucket, config.region, desktop.marker)
  const completed = desktop && runtime ? '桌面壳和视频生成引擎' : desktop ? '桌面壳' : '视频生成引擎'
  console.log(`\n[发布] ${completed}已上传完成`)
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(`\n[发布失败] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

export { desktopArtifacts, runtimeArtifacts, validateDesktopRelease }
