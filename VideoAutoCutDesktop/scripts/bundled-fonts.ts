import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

interface FontManifest {
  family: string
  license: string
  copyright: string[]
  files: { file: string; size: number; sha256: string }[]
}

export function verifyBundledFonts(directory: string): FontManifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as FontManifest
  const required = ['NotoSansCJKsc-Regular.otf', 'NotoSansCJKsc-Bold.otf', 'LICENSE']
  if (manifest.family !== 'Noto Sans CJK SC' || manifest.license !== 'SIL Open Font License 1.1'
    || !manifest.copyright?.length || !Array.isArray(manifest.files)
    || required.some((name) => !manifest.files.some((entry) => entry.file === name))) {
    throw new Error('内置 Noto 字体清单或授权信息不完整')
  }
  for (const entry of manifest.files) {
    if (!required.includes(entry.file)) throw new Error('内置字体清单包含未知文件')
    const bytes = fs.readFileSync(path.join(directory, entry.file))
    if (bytes.length !== entry.size || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`内置字体校验失败: ${entry.file}`)
    }
  }
  return manifest
}

export function stageBundledFonts(source: string, destination: string): void {
  const manifest = verifyBundledFonts(source)
  fs.mkdirSync(destination, { recursive: true })
  for (const file of ['manifest.json', ...manifest.files.map((entry) => entry.file)]) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file))
  }
  verifyBundledFonts(destination)
}
