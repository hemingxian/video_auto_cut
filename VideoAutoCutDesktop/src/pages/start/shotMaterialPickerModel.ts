import type { FileItem, MaterialDirectoryListing } from '../../types/videoauto'
import { createMaterialDirectoryCache } from '../materials/materialDirectoryCache.ts'

export function createShotMaterialPickerCache() {
  const cache = createMaterialDirectoryCache()
  let rootId = ''
  return {
    get(id: string) { return cache.get(id || rootId) },
    set(listing: MaterialDirectoryListing) {
      if (listing.current.kind === null) rootId = listing.current.id
      cache.set(listing)
    },
    clear() { rootId = ''; cache.clear() },
  }
}
export type ShotMaterialPickerCache = ReturnType<typeof createShotMaterialPickerCache>

export type PickerSemanticSnapshot = { query: string; files: FileItem[] }

export function filesForPickerSemanticQuery(snapshot: PickerSemanticSnapshot | null, searchText: string): FileItem[] {
  const query = searchText.trim()
  return query && snapshot?.query === query ? snapshot.files : []
}

// The caller owns the cache within its account-keyed React tree. Only requests
// from the current mounted picker may replace its visible directory or cache.
export function createShotMaterialPickerBrowser(cache: ShotMaterialPickerCache) {
  let revision = 0
  return {
    cancel() { revision += 1 },
    async load(
      folderId: string,
      read: (folderId: string) => Promise<MaterialDirectoryListing>,
      onSnapshot: (listing: MaterialDirectoryListing) => void,
    ): Promise<{ status: 'loaded' | 'stale' } | { status: 'error'; error: unknown }> {
      const request = ++revision
      const cached = cache.get(folderId)
      if (cached) onSnapshot(cached)
      try {
        const listing = await read(folderId)
        if (request !== revision) return { status: 'stale' }
        cache.set(listing)
        onSnapshot(listing)
        return { status: 'loaded' }
      } catch (error) {
        return request === revision ? { status: 'error', error } : { status: 'stale' }
      }
    },
  }
}

// Coalesce bursts, including events received during a slow directory read.
// At most one refresh is running, with one trailing refresh for newer events.
export function createPickerRefreshScheduler(refresh: () => Promise<void>, delay = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pending = false
  let canceled = false
  const schedule = () => {
    if (canceled || running || timer || !pending) return
    timer = setTimeout(() => {
      timer = undefined
      pending = false
      running = true
      const settled = () => { running = false; schedule() }
      void Promise.resolve().then(refresh).then(settled, settled)
    }, delay)
  }
  return {
    request() { pending = true; schedule() },
    cancel() { canceled = true; pending = false; clearTimeout(timer) },
  }
}

export const SHOT_PICKER_PAGE_SIZE = 24

export function pageMaterialPickerListing(listing: MaterialDirectoryListing, requestedPage: number) {
  const count = listing.folders.length + listing.files.length
  const totalPages = Math.max(1, Math.ceil(count / SHOT_PICKER_PAGE_SIZE))
  const page = Math.max(1, Math.min(totalPages, Math.floor(requestedPage) || 1))
  const start = (page - 1) * SHOT_PICKER_PAGE_SIZE
  const end = start + SHOT_PICKER_PAGE_SIZE
  return {
    page,
    totalPages,
    count,
    folders: listing.folders.slice(start, end),
    files: listing.files.slice(Math.max(0, start - listing.folders.length), Math.max(0, end - listing.folders.length)),
  }
}
export function materialErrorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message}`
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    return `${String(record.name || 'Error')}: ${String(record.message || error)}`
  }
  return `Error: ${String(error)}`
}
