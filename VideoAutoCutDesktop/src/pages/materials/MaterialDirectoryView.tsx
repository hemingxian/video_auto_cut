import { ChevronRight, FolderClosed } from 'lucide-react'

import { EmptyState } from '../../components/common/EmptyState'
import { basename } from '../../lib/path'
import type {
  FileItem,
  MaterialBreadcrumb,
  MaterialDirectoryListing,
  MaterialFolderNode,
  MaterialFolderSearchResult,
} from '../../types/videoauto'
import {
  createMaterialDirectoryItems,
  formatDirectoryContents,
  hasDirectoryContents,
} from './materialDirectoryModel'
import type {
  RequestMaterialActions,
  RequestMaterialPreview,
} from './materialItemActionsModel'
import { MaterialVideoGridItem } from './MaterialVideoGridItem'

function safeName(value: string, fallback: string) {
  return basename(value, fallback)
}

function Breadcrumbs({ items, onOpen }: { items: MaterialBreadcrumb[]; onOpen: (folderId: string) => void }) {
  return <nav className="material-breadcrumbs" aria-label="素材目录导航">
    {items.map((item, index) => {
      const current = index === items.length - 1
      const name = safeName(item.name, '素材目录')
      return <span className="material-breadcrumb" key={item.id}>
        {index > 0 ? <ChevronRight className="material-breadcrumb-separator" /> : null}
        <button type="button" disabled={current} onClick={() => onOpen(item.id)}>{name}</button>
      </span>
    })}
  </nav>
}

function MaterialIconGrid({
  folders,
  files,
  onOpenFolder,
  onPreview,
  onRequestActions,
}: {
  folders: MaterialFolderNode[]
  files: FileItem[]
  onOpenFolder: (folderId: string) => void
  onPreview?: RequestMaterialPreview
  onRequestActions?: RequestMaterialActions
}) {
  const items = createMaterialDirectoryItems({ folders, files })

  return <div className="material-icon-grid">
    {items.map((item) => {
      if (item.type === 'folder') {
        const name = safeName(item.folder.name, '未命名文件夹')
        return <div
          className="material-icon-item is-folder"
          key={`folder:${item.folder.id}`}
          onContextMenu={(event) => {
            event.preventDefault()
            onRequestActions?.({ type: 'folder', folder: item.folder }, event.clientX, event.clientY)
          }}
        >
          <button
            className="material-icon-main"
            type="button"
            aria-haspopup={onRequestActions ? 'menu' : undefined}
            onClick={() => onOpenFolder(item.folder.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              onRequestActions?.({ type: 'folder', folder: item.folder }, rect.left + 12, rect.top + 12)
            }}
          >
            <span className="material-icon-visual">
              <FolderClosed className="material-browser-icon folder" />
            </span>
            <span className="material-icon-name">{name}</span>
          </button>
        </div>
      }

      return <MaterialVideoGridItem
        key={`video:${item.file.path}`}
        item={item.file}
        onPreview={(file) => onPreview?.(file)}
        onRequestActions={onRequestActions}
      />
    })}
  </div>
}

function FolderSearchResults({
  results,
  loading,
  message,
  onOpen,
  onRequestActions,
}: {
  results: MaterialFolderSearchResult[]
  loading: boolean
  message: string
  onOpen: (folderId: string) => void
  onRequestActions?: RequestMaterialActions
}) {
  if (loading) return <div className="loading-line">正在搜索文件夹...</div>
  if (message) return <EmptyState title="文件夹搜索失败" description={message} />
  if (results.length === 0) return <EmptyState title="没有找到文件夹" description="请换一个文件夹名称后重试。" />

  return <MaterialIconGrid
    folders={results.map((result) => result.folder)}
    files={[]}
    onOpenFolder={onOpen}
    onRequestActions={onRequestActions}
  />
}

export function MaterialDirectoryView({
  listing,
  loading,
  message,
  searchActive,
  searchLoading,
  searchMessage,
  searchResults,
  onOpenFolder,
  onPreview,
  onRequestActions,
}: {
  listing: MaterialDirectoryListing | null
  loading: boolean
  message: string
  searchActive: boolean
  searchLoading: boolean
  searchMessage: string
  searchResults: MaterialFolderSearchResult[]
  onOpenFolder: (folderId: string) => void
  onPreview: RequestMaterialPreview
  onRequestActions: RequestMaterialActions
}) {
  if (searchActive) {
    return <>
      <div className="material-result-head">
        <strong>文件夹搜索结果</strong>
        <span>{searchLoading ? '搜索中' : `${searchResults.length} 个文件夹`}</span>
      </div>
      <FolderSearchResults
        results={searchResults}
        loading={searchLoading}
        message={searchMessage}
        onOpen={onOpenFolder}
        onRequestActions={onRequestActions}
      />
    </>
  }

  return <>
    <div className="material-result-head material-directory-head">
      {listing ? <Breadcrumbs items={listing.breadcrumbs} onOpen={onOpenFolder} /> : <strong>素材目录</strong>}
      <span>{listing ? formatDirectoryContents(listing) : ''}</span>
    </div>

    {loading ? <div className="loading-line">正在读取素材目录...</div> : null}
    {!loading && message ? <EmptyState title="无法读取素材目录" description={message} /> : null}
    {!loading && !message && listing && !hasDirectoryContents(listing)
      ? <EmptyState title="当前文件夹为空" description="这里还没有视频或子文件夹。" />
      : null}

    {!loading && !message && listing && hasDirectoryContents(listing) ? <MaterialIconGrid
      folders={listing.folders}
      files={listing.files}
      onOpenFolder={onOpenFolder}
      onPreview={onPreview}
      onRequestActions={onRequestActions}
    /> : null}
  </>
}
