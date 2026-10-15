import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileVideo2,
  FolderClosed,
  FolderOpen,
  Library,
  Search,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CloseButton } from '../../components/common/CloseButton'
import { SelectField } from '../../components/common/SelectField'
import { cx } from '../../lib/className'
import { formatSize } from '../../lib/format'
import { basename } from '../../lib/path'
import type {
  FileItem,
  MaterialDirectoryListing,
  MaterialFolderNode,
  MaterialSelectionSummary,
} from '../../types/videoauto'
import type { MaterialUiMetadataMap } from '../materials/materialLibraryUiModel'
import { hasReusableMaterialAnalysis } from '../materials/materialLibraryUiModel'
import { MaterialImportProgressDialog } from '../materials/MaterialImportProgressDialog'
import { useMaterialImportProgress } from '../materials/useMaterialImportProgress'
import { useLazyVideoPreview } from '../materials/useLazyVideoPreview'

import {
  createPickerRefreshScheduler,
  createShotMaterialPickerBrowser,
  createShotMaterialPickerCache,
  filesForPickerSemanticQuery,
  pageMaterialPickerListing,
  type PickerSemanticSnapshot,
  type ShotMaterialPickerCache,
  materialErrorDetail,
} from './shotMaterialPickerModel'
import {
  materialVideoPreviewUrl,
  isLocalMaterialFile,
  isLocalMaterialFolder,
  localMaterialListing,
  applyMaterialSelectionSummary,
  createFolderMaterialSelection,
  materialSelectionKey,
  selectionsToMaterialBindings,
  summarizeShotMaterialSelections,
  type ShotMaterialSelection,
} from './shotMaterialSelectionModel'

export type { ShotMaterialSelection } from './shotMaterialSelectionModel'

const pickerSearchModes = [
  { label: '文件名搜索', value: 'file' },
  { label: '画面语义搜索', value: 'semantic' },
]
const emptySelections: ShotMaterialSelection[] = []

function selectionKey(kind: ShotMaterialSelection['kind'], id: string) {
  return `${kind}:${id}`
}

function fileSelection(file: FileItem): ShotMaterialSelection {
  return {
    id: file.materialId || file.path,
    kind: 'file',
    name: basename(file.name, '未命名视频'),
    file,
  }
}

function refreshSelectedFiles(
  current: Map<string, ShotMaterialSelection>,
  listing: MaterialDirectoryListing,
) {
  const filesById = new Map(listing.files.flatMap((file) => {
    const id = file.materialId || file.path
    return id ? [[id, file] as const] : []
  }))
  let changed = false
  const next = new Map(current)
  for (const [key, selection] of current) {
    if (selection.kind !== 'file') continue
    const refreshed = filesById.get(selection.id)
    if (
      !refreshed
      || (
        refreshed.analysisStatus === selection.file?.analysisStatus
        && refreshed.cloudAnalysisStatus === selection.file?.cloudAnalysisStatus
        && refreshed.localStatus === selection.file?.localStatus
        && refreshed.cloudStatus === selection.file?.cloudStatus
      )
    ) continue
    next.set(key, fileSelection(refreshed))
    changed = true
  }
  return changed ? next : current
}

function MaterialPickerFolder({
  folder,
  selected,
  selection,
  countError,
  onOpen,
  onToggle,
}: {
  folder: MaterialFolderNode
  selected: boolean
  selection?: ShotMaterialSelection
  countError: boolean
  onOpen: () => void
  onToggle: () => void
}) {
  const name = basename(folder.name, '未命名文件夹')
  const count = selection ? summarizeShotMaterialSelections([selection]).candidateCount : folder.videoCount
  return <article className={cx('shot-picker-card is-folder', selected && 'selected')}>
    <button
      className="shot-picker-check"
      type="button"
      aria-label={selected ? `取消选择文件夹 ${name}` : `选择文件夹 ${name}`}
      aria-pressed={selected}
      onClick={onToggle}
    >{selected ? <Check /> : null}</button>
    <button className="shot-picker-folder-main" type="button" onClick={onOpen}>
      <span className="shot-picker-folder-visual"><FolderClosed /></span>
      <span className="shot-picker-card-copy">
        <strong>{name}</strong>
        <span>{count == null ? countError ? '数量暂不可用' : '正在统计…' : `${count} 个视频`} · {selection && !selection.includeSubfolders ? '仅当前文件夹' : '含全部子文件夹'}</span>
      </span>
      <span className="shot-picker-open-folder"><FolderOpen />打开</span>
    </button>
  </article>
}

function MaterialPickerFile({
  file,
  selected,
  tone,
  onToggle,
}: {
  file: FileItem
  selected: boolean
  tone?: string
  onToggle: () => void
}) {
  const name = basename(file.name, '未命名视频')
  const previewUrl = materialVideoPreviewUrl(file)
  const {
    activated, frameReady, handleError, handleLoadedMetadata,
    hostRef, loadFailed, setFrameReady, videoRef,
  } = useLazyVideoPreview()
  const analysisText = hasReusableMaterialAnalysis(file)
    ? '已分析'
    : file.analysisStatus === 'analyzing'
      ? '分析中'
      : file.analysisStatus === 'failed'
        ? '分析失败'
        : '待分析'
  const storageText = file.localStatus === 'damaged' && file.cloudStatus === 'ready'
    ? '本地损坏 · 云端可恢复'
    : file.localStatus === 'missing' && file.cloudStatus === 'ready'
    ? '仅云端'
    : file.localStatus === 'present' && file.cloudStatus === 'ready'
      ? '本地和云端'
      : file.localStatus === 'present'
        ? '仅本地'
        : '本地缺失'
  return <div ref={hostRef} className={cx('shot-picker-card is-file', selected && 'selected')}>
    <button
      className="shot-picker-check"
      type="button"
      aria-label={selected ? `取消选择素材 ${name}` : `选择素材 ${name}`}
      aria-pressed={selected}
      onClick={onToggle}
    >{selected ? <Check /> : null}</button>
    <button className="shot-picker-file-main" type="button" onClick={onToggle}>
      <span className={cx('shot-picker-file-visual', `tone-${tone || 'teal'}`)}>
        {previewUrl && activated && !loadFailed ? <video
          ref={videoRef}
          aria-hidden="true"
          className={frameReady ? 'is-ready' : undefined}
          draggable={false}
          muted
          playsInline
          preload="metadata"
          src={previewUrl}
          tabIndex={-1}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={() => setFrameReady(true)}
          onSeeked={() => setFrameReady(true)}
          onError={handleError}
        /> : null}
        {!frameReady || loadFailed ? <FileVideo2 /> : null}
      </span>
      <span className="shot-picker-card-copy">
        <strong>{name}</strong>
        <span>{formatSize(file.size)} · {analysisText} · {storageText}</span>
      </span>
    </button>
  </div>
}

function SelectedMaterialTray({
  selections,
  counting,
  countError,
  onRetryCount,
  onRemove,
  onToggleSubfolders,
}: {
  selections: ShotMaterialSelection[]
  counting: boolean
  countError: string
  onRetryCount: () => void
  onRemove: (selection: ShotMaterialSelection) => void
  onToggleSubfolders: (selection: ShotMaterialSelection) => void
}) {
  const summary = summarizeShotMaterialSelections(selections)

  return <div className="shot-picker-selection-tray">
    <div className="shot-picker-selection-summary">
      <strong>已选素材范围</strong>
      <span role="status">{summary.fileCount} 个视频 · {summary.folderCount} 个文件夹 · {counting
        ? '正在统计范围…'
        : countError ? <>{countError} <button className="button" type="button" onClick={onRetryCount}>重新统计</button></>
        : summary.candidateCount === null ? '数量尚未统计'
        : `合并去重后 ${summary.candidateCount} 个候选视频`}</span>
    </div>
    <div className="shot-picker-selection-list">
      {selections.map((selection) => <div
        className={cx('shot-picker-selection-chip', selection.kind === 'folder' && 'is-folder')}
        key={selectionKey(selection.kind, selection.id)}
      >
        {selection.kind === 'folder' ? <FolderClosed /> : <FileVideo2 />}
        <span>
          <strong>{selection.name}</strong>
          {selection.kind === 'folder' && selection.candidateKeys ? <small>{selection.candidateKeys.length} 个候选视频</small> : null}
          {selection.kind === 'folder' ? <button
            className={cx('shot-picker-subfolder-toggle', selection.includeSubfolders && 'active')}
            type="button"
            aria-pressed={selection.includeSubfolders === true}
            aria-label={`${selection.name} 包含子文件夹`}
            onClick={() => onToggleSubfolders(selection)}
          >
            <span />包含子文件夹
          </button> : null}
        </span>
        <button
          className="shot-picker-chip-remove"
          type="button"
          aria-label={`移除 ${selection.name}`}
          onClick={() => onRemove(selection)}
        ><X /></button>
      </div>)}
    </div>
  </div>
}

export function MaterialErrorDetail({ title, detail }: { title: string; detail: string }) {
  return <details className="shot-picker-message"><summary>查看详情 · {title}</summary><pre>{detail}</pre><button type="button" className="text-button" onClick={() => void navigator.clipboard.writeText(detail)}>复制详情</button></details>
}

export function ShotMaterialPickerDialog({
  fixtureListing,
  directoryCache,
  initialSelections,
  metadataOverrides,
  open,
  shotTitle,
  dialogTitle = '选择分镜素材',
  folderOnly = false,
  localOnly = false,
  allowEmptySelection = false,
  onClose,
  onConfirm,
}: {
  fixtureListing?: MaterialDirectoryListing
  directoryCache?: ShotMaterialPickerCache
  initialSelections?: ShotMaterialSelection[]
  metadataOverrides?: MaterialUiMetadataMap
  open: boolean
  shotTitle: string
  dialogTitle?: string
  folderOnly?: boolean
  localOnly?: boolean
  allowEmptySelection?: boolean
  onClose: () => void
  onConfirm: (selections: ShotMaterialSelection[]) => void
}) {
  const [browseErrorDetail, setBrowseErrorDetail] = useState('')
  const [countErrorDetail, setCountErrorDetail] = useState('')
  const startingSelections = initialSelections || emptySelections
  const [cache] = useState(() => directoryCache || createShotMaterialPickerCache())
  const [browser] = useState(() => createShotMaterialPickerBrowser(cache))
  const [listing, setListing] = useState<MaterialDirectoryListing | null>(() => fixtureListing || cache.get(''))
  const [loading, setLoading] = useState(false)
  const [semanticLoading, setSemanticLoading] = useState('')
  const [importing, setImporting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState('')
  const [searchMode, setSearchMode] = useState('file')
  const [searchText, setSearchText] = useState('')
  const [semanticSnapshot, setSemanticSnapshot] = useState<PickerSemanticSnapshot | null>(null)
  const materialImport = useMaterialImportProgress()
  const selectionVersion = useRef(0)
  const mounted = useRef(false)
  const folderTarget = useRef('')
  const gridRef = useRef<HTMLDivElement>(null)
  const [pagination, setPagination] = useState({ scope: '', page: 1 })
  const [selected, setSelected] = useState<Map<string, ShotMaterialSelection>>(
    () => new Map(startingSelections.map((item) => [selectionKey(item.kind, item.id), item])),
  )
  const [countRetry, setCountRetry] = useState(0)
  const [scopeResult, setScopeResult] = useState<{
    signature: string
    summary?: MaterialSelectionSummary
    error?: string
  } | null>(null)
  const scopeSignature = JSON.stringify(selectionsToMaterialBindings([...selected.values()]))
  const currentScopeResult = scopeResult?.signature === `${countRetry}:${scopeSignature}` ? scopeResult : null
  const countedKeys = new Set(currentScopeResult?.summary?.entries.map((entry) => entry.key))
  const scopeReady = Boolean(currentScopeResult?.summary)
    && [...selected.values()].every((selection) => countedKeys.has(materialSelectionKey(selection)))
  const selections = scopeReady
    ? applyMaterialSelectionSummary([...selected.values()], currentScopeResult!.summary!)
    : [...selected.values()].map((selection) => ({ ...selection, candidateKeys: undefined, candidateScope: undefined }))
  const counting = !fixtureListing && selected.size > 0 && !currentScopeResult
  const countError = currentScopeResult?.error
    || (currentScopeResult?.summary && !scopeReady ? '部分素材范围未完成统计，请重试或重新选择。' : '')
  const emptyScope = selected.size > 0 && scopeReady && currentScopeResult!.summary!.candidateCount === 0
  const hydrationIds = JSON.stringify([...selected.values()]
    .filter((selection) => selection.kind === 'folder' && (!selection.folder || selection.name === selection.id))
    .map((selection) => selection.id).sort())

  const loadDirectory = useCallback(async (folderId: string) => {
    folderTarget.current = folderId
    setLoading(true)
    setMessage('')
    setBrowseErrorDetail('')
    const result = await browser.load(folderId,
      (id) => window.videoAutoCut.browseMaterials(id ? { folderId: id } : undefined),
      (nextListing) => {
        setListing(nextListing)
        setSelected((current) => refreshSelectedFiles(current, nextListing))
      },
    )
    if (result.status === 'stale') return
    if (result.status === 'error') {
      console.error('[VideoAutoCut] browse materials for shot picker failed', result.error)
      setMessage('读取素材库失败，可重试；已显示的素材范围会在确认时重新校验。')
      setBrowseErrorDetail(materialErrorDetail(result.error))
    }
    setLoading(false)
  }, [browser, setSelected])

  useEffect(() => {
    if (!open || fixtureListing) return
    let active = true
    const timer = window.setTimeout(() => {
      window.videoAutoCut.summarizeMaterialSelection({ bindings: JSON.parse(scopeSignature) })
        .then((summary) => {
          if (active) {
            setCountErrorDetail('')
            setScopeResult({ signature: `${countRetry}:${scopeSignature}`, summary })
          }
        })
        .catch((error: unknown) => {
          console.error('[VideoAutoCut] count selected material scope failed', error)
          if (active) {
            setScopeResult({ signature: `${countRetry}:${scopeSignature}`, error: '范围统计失败，请重试。' })
            setCountErrorDetail(materialErrorDetail(error))
          }
        })
    }, 120)
    return () => { active = false; window.clearTimeout(timer) }
  }, [countRetry, fixtureListing, open, scopeSignature])

  useEffect(() => {
    mounted.current = open
    if (!open || fixtureListing) return () => { mounted.current = false }
    const timer = window.setTimeout(() => { void loadDirectory('') }, 0)
    return () => {
      mounted.current = false
      browser.cancel()
      window.clearTimeout(timer)
    }
  }, [browser, fixtureListing, loadDirectory, open])

  useEffect(() => {
    if (!open || fixtureListing) return
    const unresolved = JSON.parse(hydrationIds) as string[]
    if (!unresolved.length) return
    let active = true
    Promise.all(unresolved.map(async (id) => {
      try {
        const folder = await window.videoAutoCut.getMaterialFolderDetails({ folderId: id })
        return { id, folder }
      } catch {
        return null
      }
    })).then((resolved) => {
      if (!active) return
      setSelected((current) => {
        const next = new Map(current)
        resolved.forEach((entry) => {
          if (!entry) return
          const key = selectionKey('folder', entry.id)
          const previous = current.get(key)
          if (!previous) return
          next.set(key, { ...previous, folder: entry.folder, name: basename(entry.folder.name, '未命名文件夹') })
        })
        return next
      })
    })
    return () => { active = false }
  }, [fixtureListing, open, hydrationIds])

  useEffect(() => {
    if (!open || fixtureListing) return
    const refresh = createPickerRefreshScheduler(async () => {
      setCountRetry((value) => value + 1)
      await loadDirectory(folderTarget.current)
    })
    const unsubscribe = window.videoAutoCut.onMaterialLibraryEvent((event) => {
      if (event.type === 'analysis-status' || event.type === 'import-completed'
        || (event.type.startsWith('cloud-')
          && !['cloud-progress', 'cloud-sync-started', 'cloud-sync-progress', 'cloud-sync-settled', 'cloud-sync-failed'].includes(event.type)
          && !(event.type === 'cloud-sync-completed' && event.catalogChanged === false))) refresh.request()
    })
    return () => { refresh.cancel(); unsubscribe() }
  }, [fixtureListing, loadDirectory, open])

  useEffect(() => {
    if (!open || fixtureListing || searchMode !== 'semantic') return
    const query = searchText.trim()
    if (!query) {
      const clearTimer = window.setTimeout(() => setSemanticSnapshot(null), 0)
      return () => window.clearTimeout(clearTimer)
    }
    let active = true
    const timer = window.setTimeout(() => {
      setSemanticLoading(query)
      setSemanticSnapshot({ query, files: [] })
      setMessage('')
      window.videoAutoCut.semanticSearchMaterials({
        query,
        results: 30,
        threshold: 0,
        noTrim: true,
      }).then((result) => {
        if (!active) return
        setSemanticSnapshot({ query, files: result.results.flatMap((item) => {
          if (!item.localPath || !item.materialId) return []
          return [{
            name: item.name,
            path: item.localPath,
            url: item.localUrl || '',
            size: item.localSize || 0,
            mtime: item.localMtime || 0,
            ext: item.localPath.slice(item.localPath.lastIndexOf('.')).toLocaleLowerCase(),
            materialId: item.materialId,
            assetId: item.assetId,
            assetVersion: item.assetVersion,
            sourceSha256: item.sourceSha256,
            localStatus: item.localStatus,
            analysisStatus: item.analysisStatus,
            analysisError: item.analysisError,
            cloudStatus: item.cloudStatus,
          }]
        }) })
        if (!result.results.length) setMessage('没有找到匹配的已分析素材。')
      }).catch((error) => {
        console.error('[VideoAutoCut] semantic search for shot picker failed', error)
        if (active) {
          setSemanticSnapshot(null)
          setMessage('语义搜索失败，请稍后重试。')
        }
      }).finally(() => {
        if (active) setSemanticLoading('')
      })
    }, 450)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [fixtureListing, open, searchMode, searchText])

  const visibleListing = useMemo(() => listing && localOnly ? localMaterialListing(listing) : listing, [listing, localOnly])
  const filteredListing = useMemo(() => {
    if (searchMode === 'semantic') {
      return visibleListing ? { ...visibleListing, folders: [], files: filesForPickerSemanticQuery(semanticSnapshot, searchText) } : null
    }
    if (!visibleListing || !searchText.trim()) return visibleListing
    const query = searchText.trim().toLocaleLowerCase()
    return {
      ...visibleListing,
      folders: visibleListing.folders.filter((folder) => folder.name.toLocaleLowerCase().includes(query)),
      files: visibleListing.files.filter((file) => file.name.toLocaleLowerCase().includes(query)),
    }
  }, [visibleListing, searchMode, searchText, semanticSnapshot])

  if (!open) return null

  const hasNonLocalSelection = localOnly && selections.some((selection) => selection.kind === 'file'
    ? !selection.file || !isLocalMaterialFile(selection.file)
    : !selection.folder || !isLocalMaterialFolder(selection.folder))
  const hasUnreadySelectedFile = !fixtureListing && selections.some((selection) => (
    selection.kind === 'file' && !hasReusableMaterialAnalysis(selection.file)
  ))
  const hasCloudOnlySelectedFile = !fixtureListing && selections.some((selection) => (
    selection.kind === 'file'
    && selection.file?.localStatus !== 'present'
    && selection.file?.cloudStatus === 'ready'
  ))
  const currentListing = folderOnly && filteredListing
    ? { ...filteredListing, files: [] }
    : filteredListing
  const pageScope = JSON.stringify([currentListing?.current.id, searchMode, searchText, folderOnly, localOnly])
  const pageListing = currentListing ? pageMaterialPickerListing(
    currentListing, pagination.scope === pageScope ? pagination.page : 1,
  ) : null
  const searchPending = searchMode === 'semantic' && Boolean(searchText.trim()) && semanticLoading === searchText.trim()
  const folderCountLabel = (folder: MaterialFolderNode) => {
    const selection = selections.find((item) => item.kind === 'folder' && item.id === folder.id)
    const count = selection ? summarizeShotMaterialSelections([selection]).candidateCount : folder.videoCount
    return count == null ? '—' : count
  }
  const toggleSelection = (selection: ShotMaterialSelection) => {
    selectionVersion.current += 1
    const key = selectionKey(selection.kind, selection.id)
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, selection)
      return next
    })
  }
  const openFolder = (folderId: string) => {
    if (fixtureListing) return
    setSearchMode('file')
    setSearchText('')
    gridRef.current?.scrollTo({ top: 0 })
    void loadDirectory(folderId)
  }
  const importFromComputer = async () => {
    if (fixtureListing || importing) return
    setImporting(true)
    setMessage('')
    try {
      const folderId = listing?.current.canCreate ? listing.current.id : undefined
      const imported = await window.videoAutoCut.importMaterials(
        folderId ? { folderId } : undefined,
      )
      if (!mounted.current) return
      selectionVersion.current += 1
      setSelected((current) => {
        const next = new Map(current)
        imported.forEach((file) => {
          const selection = fileSelection(file)
          next.set(selectionKey(selection.kind, selection.id), selection)
        })
        return next
      })
      await loadDirectory(folderTarget.current)
    } catch (error) {
      console.error('[VideoAutoCut] import material from shot picker failed', error)
      if (mounted.current) setMessage('导入素材失败，请确认文件格式和存储空间后重试。')
    } finally {
      if (mounted.current) setImporting(false)
    }
  }
  const confirmSelection = async () => {
    if (hasNonLocalSelection || (!selections.length && !allowEmptySelection)) return
    if (!selections.length && allowEmptySelection) {
      onConfirm([])
      return
    }
    if (fixtureListing) {
      onConfirm(selections)
      return
    }
    if (!scopeReady || emptyScope) return
    const version = selectionVersion.current
    const materialIds = selections.flatMap((selection) => {
      if (selection.kind !== 'file') return []
      const materialId = selection.file?.materialId || selection.id
      return materialId.startsWith('mat_') ? [materialId] : []
    })
    setConfirming(true)
    setMessage('')
    try {
      const result = await window.videoAutoCut.resolveMaterialSelection({ materialIds })
      if (!mounted.current || selectionVersion.current !== version) return
      if (!result.ok) {
        setMessage(result.message || '部分素材当前不可用，请刷新素材库后重新选择。')
        return
      }
      // Navigation snapshots improve display speed only; they never authorize
      // a frozen candidate scope. Recount the exact bindings at confirmation.
      const summary = await window.videoAutoCut.summarizeMaterialSelection({ bindings: selectionsToMaterialBindings(selections) })
      if (!mounted.current || selectionVersion.current !== version) return
      setCountErrorDetail('')
      setScopeResult({ signature: `${countRetry}:${scopeSignature}`, summary })
      if (!summary.candidateCount) {
        setMessage('所选范围已没有可用视频，请包含子文件夹或重新选择。')
        return
      }
      onConfirm(applyMaterialSelectionSummary(selections, summary))
    } catch (error) {
      console.error('[VideoAutoCut] validate shot material selection failed', error)
      if (mounted.current) {
        setMessage('素材范围校验失败，请重试或重新选择。')
        setCountErrorDetail(materialErrorDetail(error))
      }
    } finally {
      if (mounted.current) setConfirming(false)
    }
  }

  return <>
    <div className="shot-picker-overlay">
      <section className="shot-picker-dialog" role="dialog" aria-modal="true" aria-label={dialogTitle}>
      <header className="shot-picker-head">
        <div>
          <Library />
          <span>
            <strong>{dialogTitle}</strong>
            <em>{shotTitle}</em>
          </span>
        </div>
        <div className="shot-picker-head-actions">
          {!folderOnly ? <button className="button" type="button" disabled={importing} onClick={() => { void importFromComputer() }}>
            <Upload className="button-icon" />{importing ? '正在导入…' : '从电脑导入'}
          </button> : null}
          <CloseButton onClick={onClose} iconClassName="icon" />
        </div>
      </header>

      <div className="shot-picker-toolbar">
        <div className="shot-picker-search-mode">
          <SelectField value={searchMode} options={localOnly ? pickerSearchModes.slice(0, 1) : pickerSearchModes} onChange={setSearchMode} />
        </div>
        <div className="search-field shot-picker-search">
          <Search className="search-icon" />
          <input
            value={searchText}
            placeholder={searchMode === 'semantic' ? '描述需要的画面内容' : '搜索文件夹或视频文件名'}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <span className="shot-picker-safe-tip">选择模式不会删除、移动或重命名素材</span>
      </div>

      <div className="shot-picker-browser">
        <aside className="shot-picker-folder-tree" aria-label="素材文件夹导航">
          <strong>素材位置</strong>
          {listing?.breadcrumbs.map((folder, index) => <button
            className={index === listing.breadcrumbs.length - 1 ? 'active' : undefined}
            key={folder.id}
            type="button"
            style={{ paddingLeft: 9 + index * 14 }}
            onClick={() => { void openFolder(folder.id) }}
          >
            {index === 0 ? <Library /> : <FolderClosed />}
            {basename(folder.name, index === 0 ? '全部素材' : '未命名文件夹')}
          </button>)}
          {visibleListing?.folders.map((folder) => <button
            key={folder.id}
            type="button"
            style={{ paddingLeft: 9 + visibleListing.breadcrumbs.length * 14 }}
            onClick={() => { void openFolder(folder.id) }}
          >
            <FolderClosed />{basename(folder.name, '未命名文件夹')}
            <span>{folderCountLabel(folder)}</span>
          </button>)}
        </aside>

        <main className="shot-picker-results">
          <div className="shot-picker-result-head">
            <nav>
              {currentListing?.breadcrumbs.map((folder, index) => <span key={folder.id}>
                {index ? <ChevronRight /> : null}
                {index === currentListing.breadcrumbs.length - 1
                  ? basename(folder.name, '当前目录')
                  : <button type="button" onClick={() => { void openFolder(folder.id) }}>
                      {basename(folder.name, '素材库')}
                    </button>}
              </span>)}
            </nav>
            <span className="shot-picker-current-actions">
              {currentListing?.current.kind && (!localOnly || isLocalMaterialFolder(currentListing.current)) ? <button
                className={cx(
                  'shot-picker-select-current',
                  selected.has(selectionKey('folder', currentListing.current.id)) && 'active',
                )}
                type="button"
                onClick={() => toggleSelection(createFolderMaterialSelection(currentListing.current))}
              >
                {selected.has(selectionKey('folder', currentListing.current.id)) ? <Check /> : <FolderClosed />}
                {selected.has(selectionKey('folder', currentListing.current.id)) ? '已选择当前目录' : '选择当前目录'}
              </button> : null}
              <span>{currentListing ? `当前列表：${currentListing.folders.length} 个文件夹 · ${currentListing.files.length} 个视频` : ''}</span>
            </span>
          </div>
          {loading || searchPending ? <div className="loading-line" role="status">{searchPending ? '正在搜索素材…' : currentListing ? '正在更新素材…' : '正在读取素材…'}</div> : null}
          {message ? <div className="shot-picker-message">{message}</div> : null}
          {browseErrorDetail ? <MaterialErrorDetail title="读取素材库失败详情" detail={browseErrorDetail} /> : null}
          {countErrorDetail ? <MaterialErrorDetail title="范围统计失败详情" detail={countErrorDetail} /> : null}
          {currentListing && pageListing ? <div ref={gridRef} className="shot-picker-grid" aria-busy={loading || searchPending}>
            {pageListing.folders.map((folder) => {
              const key = selectionKey('folder', folder.id)
              return <MaterialPickerFolder
                key={key}
                folder={folder}
                selected={selected.has(key)}
                selection={selections.find((selection) => selection.kind === 'folder' && selection.id === folder.id)}
                countError={Boolean(countError)}
                onOpen={() => { void openFolder(folder.id) }}
                onToggle={() => toggleSelection(createFolderMaterialSelection(folder))}
              />
            })}
            {pageListing.files.map((file) => {
              const key = selectionKey('file', file.materialId || file.path)
              return <MaterialPickerFile
                key={`${key}:${file.url || ''}`}
                file={file}
                selected={selected.has(key)}
                tone={metadataOverrides?.[file.path]?.thumbnailTone}
                onToggle={() => toggleSelection(fileSelection(file))}
              />
            })}
            {!pageListing.count && !loading && !searchPending && !message ? <div className="shot-picker-empty">{searchText.trim() ? '没有找到匹配的素材' : '当前目录暂无素材'}</div> : null}
          </div> : null}
          {pageListing && pageListing.totalPages > 1 ? <nav className="shot-picker-pagination" aria-label="绑定素材分页">
            <span>每页 24 项 · 共 {pageListing.count} 项</span>
            <div>
              <button className="button" type="button" aria-label="上一页素材" disabled={pageListing.page <= 1} onClick={() => {
                gridRef.current?.scrollTo({ top: 0 })
                setPagination({ scope: pageScope, page: pageListing.page - 1 })
              }}><ChevronLeft /></button>
              <span aria-live="polite">{pageListing.page} / {pageListing.totalPages}</span>
              <button className="button" type="button" aria-label="下一页素材" disabled={pageListing.page >= pageListing.totalPages} onClick={() => {
                gridRef.current?.scrollTo({ top: 0 })
                setPagination({ scope: pageScope, page: pageListing.page + 1 })
              }}><ChevronRight /></button>
            </div>
          </nav> : null}
        </main>
      </div>

      <SelectedMaterialTray
        selections={selections}
        counting={counting}
        countError={countError}
        onRetryCount={() => setCountRetry((value) => value + 1)}
        onRemove={(selection) => toggleSelection(selection)}
        onToggleSubfolders={(selection) => {
          selectionVersion.current += 1
          const key = selectionKey(selection.kind, selection.id)
          setSelected((current) => {
            const next = new Map(current)
            next.set(key, { ...selection, includeSubfolders: !selection.includeSubfolders })
            return next
          })
        }}
      />

      <footer className="shot-picker-footer">
        <span>{emptyScope
          ? '所选范围没有视频，请包含子文件夹或重新选择。'
          : hasNonLocalSelection
          ? '部分已选素材在本机不可用，请移除后重新选择。'
          : hasUnreadySelectedFile
          ? '已选视频仍在分析或分析失败，完成分析后才能确认。'
          : hasCloudOnlySelectedFile
            ? '包含仅云端素材；开始生成前会自动下载并校验，不会扩大检索范围。'
            : localOnly
              ? '绑定后仅在所选本地范围内选取画面；移除全部选择后可解除绑定，恢复自动获取。'
            : folderOnly
              ? '确认后会把所选文件夹应用到当前任务的全部分镜。'
              : '确认后只会在这些素材中检索画面，不会搜索全局素材库。'}</span>
        <div>
          <button className="button" type="button" onClick={onClose}>取消</button>
          <button
            className="button primary"
            type="button"
            disabled={(!selections.length && !allowEmptySelection) || hasNonLocalSelection || hasUnreadySelectedFile || confirming || (!fixtureListing && selections.length > 0 && (!scopeReady || emptyScope))}
            onClick={() => { void confirmSelection() }}
          >{confirming ? '正在校验...' : !selections.length && allowEmptySelection
            ? startingSelections.length ? '解除绑定' : '不绑定素材'
            : `确认选择（${selections.length}）`}</button>
        </div>
      </footer>
      </section>
    </div>
    <MaterialImportProgressDialog
      progress={materialImport.progress}
      onCancel={() => { void materialImport.cancel() }}
      onClose={materialImport.dismiss}
    />
  </>
}
