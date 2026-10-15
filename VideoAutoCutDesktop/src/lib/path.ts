export function basename(filePath: string, fallback = '') {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) || filePath || fallback
}

export function dirname(filePath: string) {
  const index = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return index > 0 ? filePath.slice(0, index) : filePath
}
