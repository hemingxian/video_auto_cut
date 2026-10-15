import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import * as yauzl from 'yauzl'

function openEntryStream(archive: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => archive.openReadStream(entry, (error, stream) => {
    if (error || !stream) reject(error || new Error('DOCX 正文读取失败'))
    else resolve(stream)
  }))
}

function decodeText(buffer: Buffer): string {
  const bytes = buffer.subarray(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  }
}

function xmlText(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, name: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
    if (name[0] !== '#') return named[name.toLowerCase()] || entity
    const codePoint = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
  })
}

async function readDocx(file: string): Promise<string> {
  const archive = await yauzl.openPromise(file, { lazyEntries: true })
  try {
    for await (const entry of archive.eachEntry()) {
      if (entry.fileName !== 'word/document.xml') continue
      const stream = await openEntryStream(archive, entry)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const xml = Buffer.concat(chunks).toString('utf8')
      return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
        .map((paragraph) => [...paragraph[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => xmlText(item[1])).join(''))
        .filter(Boolean).join('\n')
    }
  } finally {
    archive.close()
  }
  throw new Error('DOCX 中未找到正文')
}

export async function readVoiceScriptSource(fileValue: unknown): Promise<string> {
  const file = path.resolve(String(fileValue || ''))
  if (!file || !fs.existsSync(file)) throw new Error('口播稿源文件不存在，请重新选择脚本文件')
  const extension = path.extname(file).toLowerCase()
  if (!['.txt', '.md', '.docx'].includes(extension)) throw new Error('口播稿模式仅支持 txt、md、docx 文件')
  return extension === '.docx' ? readDocx(file) : decodeText(fs.readFileSync(file))
}

export function writeVoiceScriptBody(dataRootValue: unknown, sourceValue: unknown, bodyValue: unknown, taskIdValue: unknown): string {
  const source = path.resolve(String(sourceValue || ''))
  if (!source || !fs.existsSync(source)) throw new Error('口播稿源文件不存在，请重新选择脚本文件')
  const body = String(bodyValue ?? '')
  const dataRoot = path.resolve(String(dataRootValue || ''))
  const taskId = String(taskIdValue || '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (!dataRoot || !taskId) throw new Error('无法创建口播正文文件：任务标识无效')
  const dir = path.join(dataRoot, 'temp')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `voice_script_body_${taskId}.txt`)
  fs.writeFileSync(target, body, 'utf8')
  return target
}
