export const hexColorPattern = /^#[0-9a-fA-F]{6}$/

export function getPickerColor(value: string, fallback: string) {
  return hexColorPattern.test(value) ? value : fallback
}

export type ColorParts = {
  hex: string
  opacity: number
}

export function assColorToParts(value: string, fallback: string): ColorParts {
  const normalized = value.trim().toUpperCase().replace(/^&H/, '').replace(/&$/, '')
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(normalized)) return { hex: fallback, opacity: 1 }

  const hasAlpha = normalized.length === 8
  const alpha = hasAlpha ? Number.parseInt(normalized.slice(0, 2), 16) : 0
  const offset = hasAlpha ? 2 : 0
  const bb = normalized.slice(offset, offset + 2)
  const gg = normalized.slice(offset + 2, offset + 4)
  const rr = normalized.slice(offset + 4, offset + 6)
  return {
    hex: `#${rr}${gg}${bb}`.toUpperCase(),
    opacity: Number((1 - alpha / 255).toFixed(2)),
  }
}

export function colorParts(value: string | undefined, fallback: string): ColorParts {
  const text = String(value || '').trim()
  if (hexColorPattern.test(text)) return { hex: getPickerColor(text, fallback), opacity: 1 }
  if (text.toUpperCase().startsWith('&H')) return assColorToParts(text, fallback)
  return { hex: fallback, opacity: 1 }
}

export function colorToCss(value: string | undefined, fallback: string) {
  const parts = colorParts(value, fallback)
  if (parts.opacity >= 0.995) return parts.hex
  return `rgba(${Number.parseInt(parts.hex.slice(1, 3), 16)}, ${Number.parseInt(parts.hex.slice(3, 5), 16)}, ${Number.parseInt(parts.hex.slice(5, 7), 16)}, ${parts.opacity})`
}

export function colorSetting(values: Record<string, string>, key: string, fallback: string) {
  return colorToCss(values[key], fallback)
}

export function storedColor(hex: string, opacity = 1) {
  const normalized = getPickerColor(hex, '#FFFFFF').toUpperCase()
  if (opacity >= 0.995) return normalized

  const alpha = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
  const rr = normalized.slice(1, 3)
  const gg = normalized.slice(3, 5)
  const bb = normalized.slice(5, 7)
  return `&H${alpha}${bb}${gg}${rr}&`
}
