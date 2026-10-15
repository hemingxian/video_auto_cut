import type { MaterialDirectoryListing } from '../../types/videoauto'

// Instance-owned: never shared between mounts/accounts. Keep a small navigation
// cache while every directory open still refreshes authoritative local data.
export function createMaterialDirectoryCache(limit = 20) {
  const entries = new Map<string, MaterialDirectoryListing>()
  return {
    get(id: string) {
      const value = entries.get(id)
      if (value) { entries.delete(id); entries.set(id, value) }
      return value || null
    },
    set(value: MaterialDirectoryListing) {
      entries.delete(value.current.id)
      entries.set(value.current.id, value)
      while (entries.size > limit) entries.delete(entries.keys().next().value!)
    },
    clear() { entries.clear() },
  }
}
