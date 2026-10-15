export type VoiceScriptParagraph = { text: string; selected: boolean }

export function supportsVoiceScript(path: string): boolean {
  return /\.(?:txt|md|docx)$/i.test(path.trim())
}

export const VOICE_SCRIPT_DISABLED_HINT = '这种格式读不出确定的原文，不能用口播稿模式'

export function formatVoiceScriptDuration(characters: number): string {
  const durationSeconds = Math.ceil(characters / 4.2)
  return durationSeconds < 60
    ? `${durationSeconds} 秒`
    : `${Math.floor(durationSeconds / 60)} 分 ${durationSeconds % 60} 秒`
}

export function voiceScriptImportDecision(paths: string[], modes: Record<string, boolean>, bodyPaths: Record<string, string>, keyOf: (path: string) => string) {
  const pending = paths.filter((path) => modes[keyOf(path)] && !bodyPaths[keyOf(path)])
  return pending.length ? { action: 'open-confirm' as const, pending } : { action: 'enqueue' as const, pending: [] }
}

export function voiceScriptParagraphs(source: string): VoiceScriptParagraph[] {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const result: VoiceScriptParagraph[] = []
  let projectHeadingLevel = 0
  let fenced = false
  for (const line of lines) {
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/)
    if (heading) {
      const level = heading[1].length
      if (projectHeadingLevel && level <= projectHeadingLevel) projectHeadingLevel = 0
      if (/项目信息/.test(heading[2])) projectHeadingLevel = level
      result.push({ text: line, selected: false })
      continue
    }
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      result.push({ text: line, selected: false })
      continue
    }
    const shortKeyValue = /^\s*[^：:\n]{1,6}[：:]\s*\S.*$/.test(line)
    result.push({ text: line, selected: Boolean(line.trim()) && !projectHeadingLevel && !fenced && !shortKeyValue })
  }
  return result
}

export function buildVoiceScriptBody(paragraphs: VoiceScriptParagraph[]): string {
  return paragraphs.filter((paragraph) => paragraph.selected).map((paragraph) => paragraph.text).join('\n')
}
