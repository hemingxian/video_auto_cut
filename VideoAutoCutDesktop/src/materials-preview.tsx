import {
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { PageLayout } from './components/common/PageLayout'
import { Sidebar } from './components/layout/Sidebar'
import { MaterialLibraryToolbar } from './pages/materials/MaterialLibraryToolbar'
import { MaterialLibraryWorkspace } from './pages/materials/MaterialLibraryWorkspace'
import { materialFilterCounts } from './pages/materials/materialLibraryUiModel'
import type {
  MaterialLibraryFilter,
  MaterialLibraryViewMode,
  MaterialUiMetadataMap,
} from './pages/materials/materialLibraryUiModel'
import type { SearchMode } from './pages/materials/types'
import type { MaterialDirectoryListing } from './types/videoauto'
import './style.css'

const previewListing: MaterialDirectoryListing = {
  current: {
    id: 'product',
    name: '产品演示',
    kind: 'user',
    canCreate: true,
    folderCount: 0,
    videoCount: 24,
  },
  breadcrumbs: [
    { id: 'root', name: '素材库' },
    { id: 'mine', name: '本地素材' },
    { id: 'product', name: '产品演示' },
  ],
  rootFolders: [
    { id: 'mine', name: '本地素材', kind: 'user', videoCount: 98 },
    { id: 'download', name: '云端素材', kind: 'cloud', videoCount: 37 },
  ],
  folders: [
    { id: 'closeup', name: '产品特写', kind: 'user', videoCount: 18 },
    { id: 'interview', name: '采访素材', kind: 'user', videoCount: 16 },
  ],
  files: [
    {
      name: '产品演示_主镜头.mp4',
      path: 'preview/alpine-road-01.mp4',
      url: '',
      size: 195_035_136,
      mtime: Date.parse('2026-07-30T09:28:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '产品演示_特写01.mp4',
      path: 'preview/city-sunset.mp4',
      url: '',
      size: 96_468_992,
      mtime: Date.parse('2026-07-29T18:42:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '产品演示_讲解.mp4',
      path: 'preview/coast-drone.mp4',
      url: '',
      size: 224_395_264,
      mtime: Date.parse('2026-07-28T14:16:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '产品演示_会议现场.mp4',
      path: 'preview/forest-mist.mp4',
      url: '',
      size: 134_952_960,
      mtime: Date.parse('2026-07-27T07:55:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '产品演示_产线.mp4',
      path: 'preview/night-traffic.mp4',
      url: '',
      size: 79_691_776,
      mtime: Date.parse('2026-07-26T21:07:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '产品演示_设备细节.mp4',
      path: 'preview/product-closeup.mov',
      url: '',
      size: 163_577_856,
      mtime: Date.parse('2026-07-25T11:36:00+08:00'),
      ext: '.mov',
    },
    {
      name: '产品演示_功能界面.mp4',
      path: 'preview/lake-camp.mp4',
      url: '',
      size: 118_489_088,
      mtime: Date.parse('2026-07-24T19:20:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '产品演示_客户案例.mp4',
      path: 'preview/industrial-park.mp4',
      url: '',
      size: 143_654_912,
      mtime: Date.parse('2026-07-23T15:48:00+08:00'),
      ext: '.mp4',
    },
  ],
}

const previewMetadata: MaterialUiMetadataMap = {
  'preview/alpine-road-01.mp4': {
    analysis: 'ready',
    storage: 'both',
    visibility: 'private',
    duration: '00:42',
    resolution: '1920 × 1080',
    folderName: '产品演示',
    thumbnailTone: 'alpine',
    cardBadges: ['analysis', 'storage'],
  },
  'preview/city-sunset.mp4': {
    analysis: 'ready',
    storage: 'local',
    visibility: 'private',
    duration: '00:28',
    resolution: '1920 × 1080',
    folderName: '产品演示',
    thumbnailTone: 'city',
    cardBadges: ['storage'],
  },
  'preview/coast-drone.mp4': {
    analysis: 'processing',
    storage: 'cloud',
    visibility: 'public',
    duration: '01:15',
    resolution: '3840 × 2160',
    folderName: '产品演示',
    thumbnailTone: 'coast',
    cardBadges: ['storage', 'visibility'],
  },
  'preview/forest-mist.mp4': {
    analysis: 'pending',
    storage: 'local',
    visibility: 'private',
    duration: '00:36',
    resolution: '2560 × 1440',
    folderName: '产品演示',
    thumbnailTone: 'forest',
    cardBadges: ['storage'],
  },
  'preview/night-traffic.mp4': {
    analysis: 'ready',
    storage: 'local',
    visibility: 'private',
    duration: '00:31',
    resolution: '1920 × 1080',
    folderName: '产品演示',
    thumbnailTone: 'night',
    cardBadges: ['analysis'],
  },
  'preview/product-closeup.mov': {
    analysis: 'processing',
    storage: 'local',
    visibility: 'private',
    duration: '00:27',
    resolution: '3840 × 2160',
    folderName: '产品演示',
    thumbnailTone: 'studio',
    cardBadges: ['analysis'],
  },
  'preview/lake-camp.mp4': {
    analysis: 'ready',
    storage: 'cloud',
    visibility: 'public',
    duration: '00:45',
    resolution: '1920 × 1080',
    folderName: '产品演示',
    thumbnailTone: 'sunset',
    cardBadges: ['analysis', 'storage'],
  },
  'preview/industrial-park.mp4': {
    analysis: 'failed',
    storage: 'sync_failed',
    visibility: 'private',
    duration: '00:39',
    resolution: '2560 × 1440',
    folderName: '产品演示',
    thumbnailTone: 'teal',
    cardBadges: ['storage'],
  },
}

export function MaterialsPreview() {
  const [activeFilter, setActiveFilter] = useState<MaterialLibraryFilter>('all')
  const [viewMode, setViewMode] = useState<MaterialLibraryViewMode>('grid')
  const [searchMode, setSearchMode] = useState<SearchMode>('file')
  const [searchText, setSearchText] = useState('')
  const listing = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase()
    if (!query) return previewListing
    return {
      ...previewListing,
      files: previewListing.files.filter((file) => file.name.toLocaleLowerCase().includes(query)),
    }
  }, [searchText])
  const filterCounts = useMemo(
    () => materialFilterCounts(listing, previewMetadata),
    [listing],
  )

  return <div className="app-shell material-preview-shell">
    <Sidebar
      activePage="materials"
      auth={{
        loggedIn: true,
        user: {
          id: 'preview-user',
          displayName: '设计验收',
          balance: 128,
        },
      }}
      onNavigate={() => undefined}
      onAccount={() => undefined}
    />
    <main className="main-area">
      <div className="page-view">
        <PageLayout
          className="materials-page"
          bodyClassName="no-scroll"
          title="素材库"
          action={<div className="material-page-header">
            <div className="material-page-title">
              <h1>素材库</h1>
            </div>
            <div className="button-row">
              <button className="button" type="button"><RefreshCw className="button-icon" />刷新</button>
              <button className="button" type="button"><FolderOpen className="button-icon" />素材目录</button>
              <button className="button" type="button"><FolderPlus className="button-icon" />新建文件夹</button>
              <button className="button primary" type="button"><Upload className="button-icon" />添加素材</button>
            </div>
          </div>}
        >
          <div className="materials-surface">
            <MaterialLibraryToolbar
              activeFilter={activeFilter}
              autoSyncEnabled
              autoSyncSaving={false}
              busy={false}
              filterCounts={filterCounts}
              folderSearchActive={false}
              onAutoSyncChange={() => undefined}
              onClearSearch={() => setSearchText('')}
              onFilterChange={setActiveFilter}
              onSearchModeChange={setSearchMode}
              onSearchTextChange={setSearchText}
              onSubmitSearch={() => undefined}
              onViewModeChange={setViewMode}
              searchMode={searchMode}
              searchText={searchText}
              viewMode={viewMode}
            />
            <div className="material-browser">
              <MaterialLibraryWorkspace
                activeFilter={activeFilter}
                initialSelection={[
                  'preview/alpine-road-01.mp4',
                  'preview/city-sunset.mp4',
                  'preview/coast-drone.mp4',
                ]}
                listing={listing}
                loading={false}
                message=""
                metadataOverrides={previewMetadata}
                onCreateFolder={() => undefined}
                onOpenFolder={() => undefined}
                onPreview={() => undefined}
                onRequestActions={() => undefined}
                viewMode={viewMode}
              />
            </div>
          </div>
        </PageLayout>
      </div>
    </main>
  </div>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MaterialsPreview />
  </StrictMode>,
)
