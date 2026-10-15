import type { ProgressTemplateRecord } from '../../types/videoauto'

export const DEFAULT_PROGRESS_TEMPLATE_KEY = 'classic'

export type ProgressTemplateItem = ProgressTemplateRecord & {
  source: 'built-in' | 'user'
}

export function progressTemplateItems(
  builtInTemplates: ProgressTemplateRecord[],
  userTemplates: ProgressTemplateRecord[],
): ProgressTemplateItem[] {
  const defaultTemplate = builtInTemplates.find((template) => template.key === DEFAULT_PROGRESS_TEMPLATE_KEY)
  const ordered = [
    ...userTemplates.map((template) => ({ ...template, source: 'user' as const })),
    ...builtInTemplates
      .filter((template) => template.key !== DEFAULT_PROGRESS_TEMPLATE_KEY)
      .map((template) => ({ ...template, source: 'built-in' as const })),
    ...(defaultTemplate ? [{ ...defaultTemplate, source: 'built-in' as const }] : []),
  ]
  const seen = new Set<string>()
  return ordered.filter((template) => {
    if (seen.has(template.key)) return false
    seen.add(template.key)
    return true
  })
}

export function selectedProgressTemplateKey(value: unknown) {
  const key = typeof value === 'string' ? value.trim() : ''
  return key || DEFAULT_PROGRESS_TEMPLATE_KEY
}

export function resolveProgressTemplate(items: ProgressTemplateItem[], selectedKey: string) {
  return items.find((template) => template.key === selectedKey)
    || items.find((template) => template.key === DEFAULT_PROGRESS_TEMPLATE_KEY)
    || items[items.length - 1]
}

export function featuredProgressTemplates(
  items: ProgressTemplateItem[],
  selectedKey: string,
  limit = 4,
) {
  if (limit <= 0) return []
  const defaultTemplate = items.find((template) => template.key === DEFAULT_PROGRESS_TEMPLATE_KEY)
  const selected = items.find((template) => template.key === selectedKey)
  const candidates = [selected, ...items]
    .filter((template): template is ProgressTemplateItem => Boolean(template))
    .filter((template) => template.key !== DEFAULT_PROGRESS_TEMPLATE_KEY)
  const seen = new Set<string>()
  const leading = candidates.filter((template) => {
    if (seen.has(template.key)) return false
    seen.add(template.key)
    return true
  })
  return defaultTemplate
    ? [...leading.slice(0, Math.max(0, limit - 1)), defaultTemplate]
    : leading.slice(0, limit)
}
