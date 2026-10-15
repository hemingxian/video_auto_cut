import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  FileVideo2,
  FolderInput,
  House,
  Maximize2,
  MoreVertical,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'

import thumbnailSpriteA from '../../assets/material-thumbnails-industrial-a.png'
import thumbnailSpriteB from '../../assets/material-thumbnails-industrial-b.png'
import { EmptyState } from '../../components/common/EmptyState'
import { cx } from '../../lib/className'
import { formatSize } from '../../lib/format'
import { basename } from '../../lib/path'
import type { FileItem, MaterialDirectoryListing } from '../../types/videoauto'
import {
  analysisLabel,
  materialBackupLabel,
  downloadTransferLabel,
  materialDownloadProgressPercent,
  materialMetadataFor,
  materialSelectionAfterPageToggle,
  materialSelectionAfterToggle,
  materialUploadProgressPercent,
  storageLabel,
  uploadTransferLabel,
  visibleMaterialFiles,
  type MaterialLibraryFilter,
  type MaterialLibraryViewMode,
  type MaterialUiMetadata,
  type MaterialUiMetadataMap,
  type MaterialThumbnailTone,
} from './materialLibraryUiModel'
import type {
  MaterialActionFolder,
  RequestMaterialActions,
  RequestMaterialPreview,
} from './materialItemActionsModel'
import { useMaterialDragSource } from './materialDragAndDrop'
import { useLazyVideoPreview } from './useLazyVideoPreview'
import { formatVideoDuration } from './videoPreviewModel'
import { MaterialMediaPlayer } from './MaterialMediaPlayer'
import { measureMaterialUiResponse } from './materialUiPerformance'

const MaterialFolderTree = lazy(async () => {
  const module = await import('./MaterialFolderTree')
  return { default: module.MaterialFolderTree }
})

const fallbackSprites: Record<MaterialThumbnailTone, { image: string; position: string }> = {
  alpine: { image: thumbnailSpriteA, position: '0% 0%' },
  city: { image: thumbnailSpriteA, position: '100% 0%' },
  coast: { image: thumbnailSpriteA, position: '0% 100%' },
  forest: { image: thumbnailSpriteA, position: '100% 100%' },
  night: { image: thumbnailSpriteB, position: '0% 0%' },
  studio: { image: thumbnailSpriteB, position: '100% 0%' },
  sunset: { image: thumbnailSpriteB, position: '0% 100%' },
  teal: { image: thumbnailSpriteB, position: '100% 100%' },
}

function safeName(value: string, fallback: string) {
  return basename(value, fallback)
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => (
    typeof window === 'undefined' ? true : window.matchMedia(query).matches
  ))

  useEffect(() => {
    const mediaQuery = window.matchMedia(query)
    const update = () => setMatches(mediaQuery.matches)
    update()
    mediaQuery.addEventListener('change', update)
    return () => mediaQuery.removeEventListener('change', update)
  }, [query])

  return matches
}

function StorageBadge({ metadata }: { metadata: MaterialUiMetadata }) {
  const download = metadata.downloadTransfer
  const upload = metadata.uploadTransfer
  const transfer = download || upload
  const progress = download
    ? materialDownloadProgressPercent(metadata)
    : upload && metadata.backup !== 'waiting_analysis' && metadata.backup !== 'analyzing' && metadata.backup !== 'analysis_failed'
      ? materialUploadProgressPercent(metadata)
      : undefined
  const label = download
    ? downloadTransferLabel(download)
    : metadata.backup
      ? materialBackupLabel(metadata.backup)
      : storageLabel(metadata.storage)
  return <span className={cx(
    'material-library-badge',
    transfer ? `transfer-${transfer}` : `storage-${metadata.storage}`,
  )}>
    {`${label}${transfer && progress !== undefined ? ` ${progress}%` : ''}`}
  </span>
}

function TransferProgress({ metadata }: { metadata: MaterialUiMetadata }) {
  const download = metadata.downloadTransfer
  const upload = metadata.uploadTransfer
  if (!download && !upload) return null
  if (!download && ['waiting_analysis', 'analyzing', 'analysis_failed'].includes(metadata.backup || '')) return null
  const progress = download
    ? materialDownloadProgressPercent(metadata)
    : materialUploadProgressPercent(metadata)
  const transferred = Math.max(
    0,
    download ? metadata.downloadBytesTransferred || 0 : metadata.uploadBytesTransferred || 0,
  )
  const total = Math.max(
    0,
    download ? metadata.downloadTotalBytes || 0 : metadata.uploadTotalBytes || 0,
  )
  const speed = Math.max(
    0,
    download ? metadata.downloadSpeedBytesPerSecond || 0 : metadata.uploadSpeedBytesPerSecond || 0,
  )
  const active = download === 'downloading' || upload === 'uploading'
  const statusLabel = download ? downloadTransferLabel(download) : uploadTransferLabel(upload!)
  return <div className="material-library-upload-progress" role="status">
    <div>
      <span>{total > 0 ? `${formatSize(transferred)} / ${formatSize(total)}` : statusLabel}</span>
      {active && speed > 0
        ? <em>{formatSize(speed)}/s</em>
        : null}
    </div>
    <span className="material-library-upload-progress-track" aria-label={`上传进度 ${progress || 0}%`}>
      <i style={{ width: `${progress || 0}%` }} />
    </span>
  </div>
}

function AnalysisBadge({ metadata }: { metadata: MaterialUiMetadata }) {
  return <span className={cx('material-library-badge', `analysis-${metadata.analysis}`)}>
    {analysisLabel(metadata.analysis)}
  </span>
}

function VisibilityBadge({ metadata }: { metadata: MaterialUiMetadata }) {
  const label = metadata.visibility === 'public'
    ? '公开'
    : metadata.visibility === 'publishing'
      ? '审核中'
      : metadata.visibility === 'suspended'
        ? '已暂停'
        : '私有'
  return <span className="material-library-badge visibility">
    {label}
  </span>
}

function MaterialThumbnail({
  detail = false,
  file,
  metadata,
  onPreview,
}: {
  detail?: boolean
  file: FileItem
  metadata: MaterialUiMetadata
  onPreview: RequestMaterialPreview
}) {
  const {
    activated,
    duration: durationSeconds,
    frameReady,
    handleError,
    handleLoadedMetadata,
    hostRef,
    loadFailed,
    setFrameReady,
    videoRef,
  } = useLazyVideoPreview()
  const duration = metadata.duration || formatVideoDuration(durationSeconds)
  const fallback = fallbackSprites[metadata.thumbnailTone || 'teal']
  const thumbnailStyle = {
    '--material-thumbnail-sprite': `url("${fallback.image}")`,
    '--material-thumbnail-position': fallback.position,
  } as CSSProperties

  return <div
    className={cx('material-library-thumbnail', detail && 'is-detail')}
    ref={hostRef}
    style={thumbnailStyle}
  >
    <span className="material-library-thumbnail-art" aria-hidden="true" />
    {activated && !loadFailed && file.url ? <video
      ref={videoRef}
      className={frameReady ? 'is-ready' : ''}
      src={file.url}
      muted
      playsInline
      preload="metadata"
      onError={handleError}
      onLoadedData={() => setFrameReady(true)}
      onLoadedMetadata={handleLoadedMetadata}
      onSeeked={() => setFrameReady(true)}
    /> : null}
    {!file.url && !metadata.duration ? <FileVideo2 className="material-library-thumbnail-file" /> : null}
    {detail ? <div className="material-library-player-chrome">
      <div className="material-library-player-progress"><span /></div>
      <div className="material-library-player-controls">
        <button type="button" aria-label={`播放 ${safeName(file.name, '视频素材')}`} onClick={() => onPreview(file)}><Play /></button>
        <span>00:00 / {duration || '00:00'}</span>
        <i />
        <button type="button" aria-label="音量"><Volume2 /></button>
        <button type="button" aria-label="全屏"><Maximize2 /></button>
      </div>
    </div> : <>
      <button
        className="material-library-play"
        type="button"
        aria-label={`预览 ${safeName(file.name, '视频素材')}`}
        onClick={(event) => {
          event.stopPropagation()
          onPreview(file)
        }}
      ><Play /></button>
      {duration ? <span className="material-library-duration">{duration}</span> : null}
    </>}
  </div>
}

function MaterialCard({
  dragEnabled,
  dragPaths,
  file,
  metadata,
  onDragStart,
  focused,
  selected,
  sourceFolderId,
  viewMode,
  onPreview,
  onRequestActions,
  onFocus,
  onSelect,
}: {
  dragEnabled: boolean
  dragPaths: string[]
  file: FileItem
  metadata: MaterialUiMetadata
  onDragStart: () => void
  focused: boolean
  selected: boolean
  sourceFolderId: string
  viewMode: MaterialLibraryViewMode
  onPreview: RequestMaterialPreview
  onRequestActions: RequestMaterialActions
  onFocus: () => void
  onSelect: () => void
}) {
  const name = safeName(file.name, '未命名视频')
  const badges = metadata.cardBadges || ['storage', 'analysis']
  const { dragging, elementRef } = useMaterialDragSource({
    enabled: dragEnabled,
    onDragStart,
    paths: dragPaths,
    sourceFolderId,
  })
  return <article
    className={cx(
      'material-library-card',
      focused && 'is-focused',
      selected && 'selected',
      dragging && 'dragging',
      viewMode === 'list' && 'is-list',
    )}
    ref={elementRef}
    onClick={onFocus}
    onContextMenu={(event) => {
      event.preventDefault()
      onRequestActions({ type: 'file', file }, event.clientX, event.clientY)
    }}
  >
    <button
      className="material-library-select"
      type="button"
      aria-label={selected ? `取消选择 ${name}` : `选择 ${name}`}
      aria-pressed={selected}
      onClick={onSelect}
    >{selected ? <Check /> : null}</button>
    <MaterialThumbnail file={file} metadata={metadata} onPreview={onPreview} />
    <button className="material-library-card-main" type="button" onClick={() => onPreview(file)}>
      <strong>{name}</strong>
    </button>
    <div className="material-library-card-status">
      {badges.includes('analysis') ? <AnalysisBadge metadata={metadata} /> : null}
      {badges.includes('storage') ? <StorageBadge metadata={metadata} /> : null}
      {metadata.analysisTransferFailed ? <span className="material-library-badge analysis-failed">分析同步失败</span> : null}
      {badges.includes('visibility') ? <VisibilityBadge metadata={metadata} /> : null}
    </div>
    <button
      className="material-library-more"
      type="button"
      aria-label={`更多操作 ${name}`}
      aria-haspopup="menu"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onRequestActions({ type: 'file', file }, rect.right, rect.bottom + 4)
      }}
    ><MoreVertical /></button>
  </article>
}

function DetailsPanel({
  analyzing,
  collapsed,
  downloading,
  file,
  metadata,
  onAnalyze,
  onDownload,
  onMore,
  onPreview,
  onToggleCollapsed,
}: {
  analyzing: boolean
  collapsed: boolean
  downloading: boolean
  file: FileItem | null
  metadata: MaterialUiMetadata | null
  onAnalyze?: (file: FileItem) => void
  onDownload?: (file: FileItem) => void
  onMore: (file: FileItem, x: number, y: number) => void
  onPreview: RequestMaterialPreview
  onToggleCollapsed: () => void
}) {
  return <aside className={cx('material-library-details', collapsed && 'collapsed')}>
    <div className="material-library-panel-title">
      <strong>素材详情</strong>
      <button
        type="button"
        aria-label={collapsed ? '展开素材详情' : '收起素材详情'}
        onClick={onToggleCollapsed}
      >{collapsed ? <PanelRightOpen /> : <PanelRightClose />}</button>
    </div>
    {collapsed ? null : !file || !metadata ? <div className="material-library-detail-empty">
      <FileVideo2 />
      <span>选择素材后查看详情</span>
    </div> : <>
      <MaterialMediaPlayer key={file.path} compact src={file.url} title={safeName(file.name, '未命名视频')} />
      <div className="material-library-detail-heading">
        <strong>{safeName(file.name, '未命名视频')}</strong>
      </div>
      <div className="material-library-detail-status">
        <AnalysisBadge metadata={metadata} />
        <StorageBadge metadata={metadata} />
        <VisibilityBadge metadata={metadata} />
      </div>
      <TransferProgress metadata={metadata} />
      {['waiting_analysis', 'analyzing'].includes(metadata.backup || '')
        ? <p role="status">本地分析完成后自动备份视频和分析结果。关闭应用会暂停，重新打开后继续。</p> : null}
      {metadata.backup === 'incomplete'
        ? <p role="status">原视频已在云端，分析结果尚未备份。需要在有原文件的设备完成本地分析并同步。</p> : null}
      {metadata.uploadTransfer === 'paused'
        ? <p>上传已暂停，可在“更多操作”中继续上传。</p>
        : file.cloudError ? <p className="material-library-detail-error">同步信息：{file.cloudError}。可在“更多操作”中重试上传。</p> : null}
      {metadata.analysis === 'failed' && file.analysisError
        ? <p className="material-library-detail-error">{file.analysisError}</p>
        : null}
      {file.analysisTransferStatus && file.analysisTransferStatus !== 'ready' ? <p
        className={file.analysisTransferError || file.analysisTransferStatus === 'failed' ? 'material-library-detail-error' : undefined}
        role="status"
      >
        {file.analysisTransferDirection === 'download' ? '分析索引恢复' : '分析结果同步'}：
        {file.analysisTransferStatus === 'failed' ? '已暂停重试' : file.analysisTransferStatus === 'processing' ? '处理中' : '等待处理'}
        {file.analysisTransferError ? `。${file.analysisTransferError}` : ''}
        {file.analysisTransferStatus === 'failed' ? '。可在“更多操作”中重试，使用已有分析结果。' : ''}
      </p> : file.cloudAnalysisError ? <p className="material-library-detail-error">云端分析：{file.cloudAnalysisError}</p> : null}
      {file.cloudStatus === 'ready' && file.analysisStatus === 'ready' && file.cloudAnalysisStatus !== 'ready'
        && !file.analysisTransferStatus ? <p>文件已上传，分析结果尚未同步；可在“更多操作”中同步已有分析结果。</p> : null}
      <dl className="material-library-detail-list">
        <div><dt>存储位置</dt><dd>{storageLabel(metadata.storage)}</dd></div>
        {metadata.backup ? <div><dt>云备份</dt><dd>{materialBackupLabel(metadata.backup)}</dd></div> : null}
        <div><dt>时长</dt><dd>{metadata.duration || '—'}</dd></div>
        <div><dt>分辨率</dt><dd>{metadata.resolution || '—'}</dd></div>
        <div><dt>大小</dt><dd>{formatSize(file.size)}</dd></div>
        <div><dt>所在文件夹</dt><dd>{metadata.folderName || '本地素材'}</dd></div>
      </dl>
      <div className="material-library-detail-actions">
        {file.localStatus !== 'present' && file.cloudStatus === 'ready' && onDownload
          ? <button className="button" type="button" disabled={downloading} onClick={() => onDownload(file)}>
              <CloudDownload className="button-icon" />{downloading
                ? '正在下载'
                : file.localStatus === 'damaged' ? '修复本地文件' : '下载到本地'}
            </button>
          : <button className="button" type="button" onClick={() => onPreview(file)} disabled={!file.url}>
              <Play className="button-icon" />打开视频
            </button>}
        {onAnalyze && (metadata.analysis === 'failed' || metadata.analysis === 'pending')
          ? <button
              className="button"
              type="button"
              disabled={analyzing}
              onClick={() => onAnalyze(file)}
            >
              <RefreshCw className="button-icon" />{analyzing ? '正在分析' : '重新分析'}
            </button>
          : null}
        <button
          className="button"
          type="button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            onMore(file, rect.right, rect.bottom + 4)
          }}
        >
          <MoreVertical className="button-icon" />更多操作<ChevronDown className="button-chevron" />
        </button>
      </div>
    </>}
  </aside>
}

function BatchBar({
  canDelete,
  canMove,
  canUpload,
  count,
  onClear,
  onDelete,
  onMove,
  onUpload,
  uploading,
}: {
  canDelete: boolean
  canMove: boolean
  canUpload: boolean
  count: number
  onClear: () => void
  onDelete?: () => void
  onMove?: () => void
  onUpload?: () => void
  uploading: boolean
}) {
  if (!count) return null
  return <div className="material-library-batch-bar" role="status">
    <span>已选择 <strong>{count}</strong> 项</span>
    <div>
      <button type="button" disabled={!canMove || !onMove} onClick={onMove}><FolderInput />移动</button>
      <button type="button" disabled={!canUpload || uploading || !onUpload} onClick={onUpload}>
        <CloudUpload />{uploading ? '正在加入队列' : '上传云端'}
      </button>
      <button className="danger" type="button" disabled={!canDelete || !onDelete} onClick={onDelete}><Trash2 />删除</button>
      <button className="close" type="button" aria-label="取消选择" onClick={onClear}><X /></button>
    </div>
  </div>
}

function MaterialPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  const pageStart = Math.min(Math.max(page - 2, 1), Math.max(totalPages - 4, 1))
  const pages = Array.from(
    { length: Math.min(totalPages, 5) },
    (_, index) => pageStart + index,
  )
  return <footer className="material-library-pagination">
    <nav aria-label="素材分页">
      <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft /></button>
      {pages.map((value) => <button
        className={value === page ? 'active' : undefined}
        key={value}
        type="button"
        onClick={() => onPageChange(value)}
      >{value}</button>)}
      <button type="button" aria-label="下一页" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}><ChevronRight /></button>
    </nav>
    <button className="material-library-page-size" type="button" disabled>每页 24 项<ChevronDown /></button>
  </footer>
}

export function MaterialLibraryWorkspace({
  activeFilter,
  initialSelection = [],
  listing,
  loading,
  message,
  metadataOverrides,
  folderTreeRevision = 0,
  analyzingPaths,
  downloadingPaths,
  onAnalyze,
  onCreateFolder,
  onDownload,
  onDelete,
  onDropMove,
  onMove,
  onMoveFolder,
  onOpenFolder,
  onPreview,
  onRenameFolder,
  onRequestActions,
  onUpload,
  uploadingPaths,
  viewMode,
  showRootFiles = false,
}: {
  showRootFiles?: boolean
  activeFilter: MaterialLibraryFilter
  initialSelection?: string[]
  listing: MaterialDirectoryListing | null
  loading: boolean
  message: string
  metadataOverrides?: MaterialUiMetadataMap
  folderTreeRevision?: number
  analyzingPaths?: ReadonlySet<string>
  downloadingPaths?: ReadonlySet<string>
  onAnalyze?: (file: FileItem) => void
  onCreateFolder?: () => void
  onDownload?: (file: FileItem) => void
  onDelete?: (paths: string[]) => void
  onDropMove?: (
    paths: string[],
    sourceFolderId: string,
    destinationFolderId: string,
  ) => boolean | Promise<boolean>
  onMove?: (paths: string[]) => void
  onMoveFolder?: (folder: MaterialActionFolder, destinationFolderId: string) => boolean | Promise<boolean>
  onOpenFolder: (folderId: string) => void
  onPreview: RequestMaterialPreview
  onRenameFolder?: (folder: MaterialActionFolder, name: string) => boolean | Promise<boolean>
  onRequestActions: RequestMaterialActions
  onUpload?: (paths: string[]) => void
  uploadingPaths?: ReadonlySet<string>
  viewMode: MaterialLibraryViewMode
}) {
  const pageSize = 24
  const pageScope = `${activeFilter}:${listing?.current.id || ''}`
  const [pagination, setPagination] = useState({ scope: pageScope, page: 1 })
  const page = pagination.scope === pageScope ? pagination.page : 1
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initialSelection))
  const [focusedPath, setFocusedPath] = useState(() => initialSelection[0] || '')
  const [detailsCollapsed, setDetailsCollapsed] = useState(false)
  const detailsPanelRef = usePanelRef()
  const showFolders = useMediaQuery('(min-width: 981px)')
  const showDetails = useMediaQuery('(min-width: 1261px)')
  const panelIds = useMemo(() => [
    ...(showFolders ? ['folders'] : []),
    'content',
    ...(showDetails ? ['details'] : []),
  ], [showDetails, showFolders])
  const layoutMode = showDetails ? 'wide' : showFolders ? 'compact' : 'single'
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `material-library-${layoutMode}`,
    onlySaveAfterUserInteractions: true,
    panelIds,
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  })
  const files = useMemo(
    () => listing?.current.kind === null && activeFilter === 'all' && !showRootFiles
      ? [] : visibleMaterialFiles(listing, activeFilter, metadataOverrides),
    [activeFilter, listing, metadataOverrides, showRootFiles],
  )
  const fileByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  )
  const visibleSelection = useMemo(
    () => new Set([...selected].filter((path) => fileByPath.has(path))),
    [fileByPath, selected],
  )
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize))
  const visiblePage = Math.min(page, totalPages)
  const pageFiles = useMemo(
    () => files.slice((visiblePage - 1) * pageSize, visiblePage * pageSize),
    [files, visiblePage],
  )
  const pagePaths = useMemo(() => pageFiles.map((file) => file.path), [pageFiles])
  const selectedPageCount = pagePaths.filter((path) => visibleSelection.has(path)).length
  const allPageSelected = pagePaths.length > 0 && selectedPageCount === pagePaths.length
  const visibleSelectionPaths = useMemo(() => [...visibleSelection], [visibleSelection])
  const focusedFile = fileByPath.get(focusedPath) || files[0] || null
  const focusedMetadata = focusedFile
    ? materialMetadataFor(focusedFile, metadataOverrides, listing?.current.name)
    : null
  const uploadableSelection = visibleSelectionPaths.filter((selectedPath) => {
    const file = fileByPath.get(selectedPath)
    return file?.localStatus === 'present' && file.cloudStatus !== 'ready'
  })
  const toggleDetailsPanel = useCallback(() => {
    measureMaterialUiResponse('details-panel', () => {
      if (detailsPanelRef.current?.isCollapsed()) detailsPanelRef.current.expand()
      else detailsPanelRef.current?.collapse()
    })
  }, [detailsPanelRef])
  const handlePageChange = useCallback((nextPage: number) => {
    measureMaterialUiResponse('pagination', () => setPagination({ scope: pageScope, page: nextPage }))
  }, [pageScope])

  if (loading && !listing) return <div className="loading-line">正在读取素材目录...</div>
  if (message) return <EmptyState title="无法读取素材目录" description={message} />
  if (!listing) return <EmptyState title="素材目录尚未就绪" description="请刷新后重试。" />

  const rootBreadcrumb = listing.breadcrumbs[0]
  const parentBreadcrumb = listing.breadcrumbs.at(-2)
  const insideSubfolder = Boolean(parentBreadcrumb && parentBreadcrumb.id !== listing.current.id)

  return <Group
    className="material-library-workspace"
    defaultLayout={defaultLayout}
    onLayoutChanged={onLayoutChanged}
    orientation="horizontal"
  >
    {showFolders ? <>
      <Panel id="folders" defaultSize="18%" minSize="14%" maxSize="26%">
        <Suspense fallback={<div className="material-library-folder-loading">正在加载文件夹...</div>}>
          <MaterialFolderTree
            key={`${rootBreadcrumb?.id || 'root'}:${folderTreeRevision}`}
            listing={listing}
            onCreateFolder={onCreateFolder}
            onDropFiles={onDropMove}
            onMoveFolder={onMoveFolder}
            onOpenFolder={onOpenFolder}
            onRenameFolder={onRenameFolder}
            onRequestActions={onRequestActions}
          />
        </Suspense>
      </Panel>
      <Separator className="material-library-resize-handle" />
    </> : null}
    <Panel id="content" defaultSize={showDetails ? '57%' : '82%'} minSize="42%">
      <section className="material-library-content">
      <div className="material-library-content-head">
        <div className="material-library-directory-title-row">
          <div className="material-library-directory-heading">
            {insideSubfolder ? <div className="material-library-directory-actions">
              <button
                type="button"
                aria-label="返回上级"
                title="返回上级"
                onClick={() => onOpenFolder(parentBreadcrumb!.id)}
              ><ChevronLeft /></button>
              {rootBreadcrumb && parentBreadcrumb?.id !== rootBreadcrumb.id ? <button
                type="button"
                aria-label="返回素材库"
                title="返回素材库"
                onClick={() => onOpenFolder(rootBreadcrumb.id)}
              ><House /></button> : null}
            </div> : null}
            <strong>{safeName(listing.current.name, '素材库')}</strong>
          </div>
          <div className="material-library-directory-summary">
            <button
              className={cx('material-library-select-page', allPageSelected && 'is-active')}
              type="button"
              disabled={!pagePaths.length}
              aria-pressed={allPageSelected}
              onClick={() => measureMaterialUiResponse('selection-page', () => {
                setSelected((current) => materialSelectionAfterPageToggle(current, pagePaths))
              })}
            >
              <span aria-hidden="true">{allPageSelected ? <Check /> : null}</span>
              {allPageSelected ? '取消全选' : '全选当前页'}
            </button>
            <span className="material-library-directory-count">
              {listing.current.videoCount ?? files.length} 个素材
            </span>
          </div>
        </div>
        {listing.breadcrumbs.length > 1 ? <nav aria-label="当前素材目录">
          {listing.breadcrumbs.map((item, index) => <span key={item.id}>
            {index ? <ChevronRight /> : null}
            <button
              type="button"
              disabled={index === listing.breadcrumbs.length - 1}
              onClick={() => onOpenFolder(item.id)}
            >{safeName(item.name, '素材库')}</button>
          </span>)}
        </nav> : null}
      </div>
      <BatchBar
        canDelete={listing.current.kind === 'user' && visibleSelection.size > 0}
        canMove={listing.current.kind === 'user' && visibleSelection.size > 0}
        canUpload={uploadableSelection.length > 0}
        count={visibleSelection.size}
        onClear={() => measureMaterialUiResponse('selection-clear', () => setSelected(new Set()))}
        onDelete={onDelete ? () => onDelete(visibleSelectionPaths) : undefined}
        onMove={onMove ? () => onMove(visibleSelectionPaths) : undefined}
        onUpload={onUpload ? () => onUpload(uploadableSelection) : undefined}
        uploading={uploadableSelection.some((item) => uploadingPaths?.has(item))}
      />
      {listing.current.kind === null && activeFilter === 'all' && !showRootFiles ? <div className="material-library-grid">
        {listing.folders.map((folder) => <button className="material-library-card" key={folder.id} onClick={() => onOpenFolder(folder.id)}>
          <FolderInput className="button-icon" /><strong>{folder.name}</strong><span>{folder.videoCount || 0} 个素材</span>
        </button>)}
      </div> : files.length ? <div className={cx('material-library-grid', viewMode === 'list' && 'is-list')}>
        {pageFiles.map((file) => <MaterialCard
          key={file.path}
          dragEnabled={listing.current.kind === 'user' && Boolean(onDropMove)}
          dragPaths={visibleSelection.has(file.path) ? visibleSelectionPaths : [file.path]}
          file={file}
          focused={focusedFile?.path === file.path}
          metadata={materialMetadataFor(file, metadataOverrides, listing.current.name)}
          onDragStart={() => {
            if (!visibleSelection.has(file.path)) {
              measureMaterialUiResponse('selection', () => setSelected(new Set([file.path])))
            }
          }}
          selected={visibleSelection.has(file.path)}
          sourceFolderId={listing.current.id}
          viewMode={viewMode}
          onPreview={onPreview}
          onRequestActions={onRequestActions}
          onFocus={() => measureMaterialUiResponse('details-focus', () => setFocusedPath(file.path))}
          onSelect={() => measureMaterialUiResponse('selection', () => {
            setSelected((current) => materialSelectionAfterToggle(current, file.path))
          })}
        />)}
      </div> : <EmptyState
        title={listing.current.kind === null && activeFilter === 'all' ? '选择素材位置' : '当前筛选下没有素材'}
        description={listing.current.kind === null && activeFilter === 'all' ? '打开本地素材或云端素材文件夹。' : '可以切换筛选条件，或添加新的素材。'}
      />}
      <MaterialPagination page={visiblePage} totalPages={totalPages} onPageChange={handlePageChange} />
      </section>
    </Panel>
    {showDetails ? <>
      <Separator className="material-library-resize-handle" />
      <Panel
        id="details"
        collapsible
        collapsedSize="52px"
        defaultSize="25%"
        minSize="20%"
        maxSize="36%"
        panelRef={detailsPanelRef}
        onResize={({ inPixels }) => setDetailsCollapsed(inPixels < 90)}
      >
        <DetailsPanel
          analyzing={Boolean(focusedFile && analyzingPaths?.has(focusedFile.path))}
          collapsed={detailsCollapsed}
          downloading={Boolean(focusedFile && downloadingPaths?.has(focusedFile.path))}
          file={focusedFile}
          metadata={focusedMetadata}
          onAnalyze={onAnalyze}
          onDownload={onDownload}
          onMore={(file, x, y) => onRequestActions({ type: 'file', file }, x, y)}
          onPreview={onPreview}
          onToggleCollapsed={toggleDetailsPanel}
        />
      </Panel>
    </> : null}
  </Group>
}
