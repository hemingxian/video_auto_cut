import type { CSSProperties } from 'react'

import { findProgressTemplate } from '../../config/progressTemplates'
import type { ProgressTemplateSettings } from '../../types/videoauto'
import { colorSetting } from './color'
import { DEFAULT_PROGRESS_TEMPLATE_KEY } from './progressTemplateModel'

export const DEFAULT_PROGRESS_TEMPLATE = findProgressTemplate(DEFAULT_PROGRESS_TEMPLATE_KEY)
const DEFAULT_SETTINGS = DEFAULT_PROGRESS_TEMPLATE.settings

export function completeProgressTemplateSettings(settings: ProgressTemplateSettings): ProgressTemplateSettings {
  return { ...DEFAULT_SETTINGS, ...settings }
}

function numberSetting(settings: ProgressTemplateSettings, key: string, fallback: number, min: number, max: number) {
  const parsed = Number(settings[key])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function videoWidthUnit(value: number) {
  return `${(value / 1920) * 100}cqw`
}

export function progressPreviewStyle(settings: ProgressTemplateSettings) {
  const completed = completeProgressTemplateSettings(settings)
  const height = numberSetting(completed, 'PROGRESS_BAR_HEIGHT', 76, 24, 150)
  const bottomMargin = numberSetting(completed, 'PROGRESS_BOTTOM_MARGIN', 0, 0, 220)
  const fontSize = numberSetting(completed, 'PROGRESS_FONT_SIZE', 30, 16, 52)
  return {
    '--progress-preview-height': `${(height / 1080) * 100}%`,
    '--progress-preview-bottom': `${(bottomMargin / 1080) * 100}%`,
    '--progress-preview-font-size': videoWidthUnit(fontSize),
    '--progress-preview-highlight': colorSetting(completed, 'PROGRESS_HIGHLIGHT_COLOR', '#FFFFFF'),
    '--progress-preview-dark': colorSetting(completed, 'PROGRESS_DARK_COLOR', '#323232'),
    '--progress-preview-separator': colorSetting(completed, 'PROGRESS_SEPARATOR_COLOR', '#171717'),
    '--progress-preview-text': colorSetting(completed, 'PROGRESS_TEXT_COLOR', '#B8B8B8'),
    '--progress-preview-active-text': colorSetting(completed, 'PROGRESS_ACTIVE_TEXT_COLOR', '#FFFFFF'),
  } as CSSProperties
}
