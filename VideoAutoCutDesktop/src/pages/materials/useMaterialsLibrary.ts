import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useAsyncRefresh } from '../../hooks/useAsyncRefresh'
import { useMountedRef } from '../../hooks/useMountedRef'
import { usePendingKeys } from '../../hooks/usePendingKeys'
import { confirmDestructiveAction, reportOperationResult } from '../../lib/dialog'
import { basename } from '../../lib/path'
import type {
  FileItem,
  MaterialDirectoryListing,
  MaterialFolderSearchResult,
  MaterialLibrary,
  SemanticSearchResult,
} from '../../types/videoauto'
import type { MaterialCloudStatus } from '../../types/videoauto-api'
import { emptyLibrary } from './constants'
import { buildMaterialCards } from './materialCards'
import { createMaterialFolderSearchRequest } from './materialDirectoryModel'
import { createMaterialDirectoryCache } from './materialDirectoryCache'
import { useMaterialImportProgress } from './useMaterialImportProgress'
import type {
  MaterialActionFolder,
  MaterialActionTarget,
} from './materialItemActionsModel'
import {
  hasImportedMaterials,
  type MaterialUiMetadataMap,
} from './materialLibraryUiModel'
import type { SearchMode } from './types'

const DIRECTORY_LOAD_ERROR = '读取素材目录失败，请刷新后重试。'
const FOLDER_SEARCH_ERROR = '搜索文件夹失败，请稍后重试。'
const SEMANTIC_SEARCH_ERROR = '语义搜索失败，请稍后重试。'

export function useMaterialsLibrary() {
  const mountedRef = useMountedRef()
  const [library, setLibrary] = useState<MaterialLibrary>(emptyLibrary)
  const [listing, setListing] = useState<MaterialDirectoryListing | null>(null)
  const [currentFolderId, setCurrentFolderId] = useState<string>()
  const directoryCache = useRef(createMaterialDirectoryCache())
  const [directoryMessage, setDirectoryMessage] = useState('')
  const [searchText, setSearchTextState] = useState('')
  const [searchMode, setSearchModeState] = useState<SearchMode>('file')
  const [folderSearchQuery, setFolderSearchQuery] = useState('')
  const [folderSearchLoading, setFolderSearchLoading] = useState(false)
  const [folderSearchMessage, setFolderSearchMessage] = useState('')
  const [folderSearchResults, setFolderSearchResults] = useState<MaterialFolderSearchResult[]>([])
  const folderSearchRequestRef = useRef(0)
  const [semanticLoading, setSemanticLoading] = useState(false)
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[]>([])
  const [semanticMessage, setSemanticMessage] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderTreeRevision, setFolderTreeRevision] = useState(0)
  const [importingMaterials, setImportingMaterials] = useState(false)
  const materialImport = useMaterialImportProgress()
  const [movingMaterials, setMovingMaterials] = useState(false)
  const [deletingBatch, setDeletingBatch] = useState(false)
  const { pendingKeys: deletingPaths, runWithPending } = usePendingKeys<string>()
  const { pendingKeys: renamingPaths, runWithPending: runRenameWithPending } = usePendingKeys<string>()
  const { pendingKeys: analyzingPaths, runWithPending: runAnalysisWithPending } = usePendingKeys<string>()
  const { pendingKeys: uploadingPaths, runWithPending: runUploadWithPending } = usePendingKeys<string>()
  const { pendingKeys: downloadingPaths, runWithPending: runDownloadWithPending } = usePendingKeys<string>()
  const { pendingKeys: cloudDeletingPaths, runWithPending: runCloudDeleteWithPending } = usePendingKeys<string>()
  const { pendingKeys: localDeletingPaths, runWithPending: runLocalDeleteWithPending } = usePendingKeys<string>()
  const { pendingKeys: publicationPendingPaths, runWithPending: runPublicationWithPending } = usePendingKeys<string>()
  const [cloudStatus, setCloudStatus] = useState<MaterialCloudStatus | null>(null)
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false)
  const [autoSyncSaving, setAutoSyncSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<Record<string, {
    bytesTransferred: number
    totalBytes: number
    speedBytesPerSecond?: number
  }>>({})
  const [downloadProgress, setDownloadProgress] = useState<Record<string, {
    bytesTransferred: number
    totalBytes: number
    speedBytesPerSecond?: number
  }>>({})

  const loadDirectory = useCallback(
    () => window.videoAutoCut.browseMaterials(currentFolderId ? { folderId: currentFolderId } : undefined),
    [currentFolderId],
  )
  const applyDirectory = useCallback((value: MaterialDirectoryListing) => {
    directoryCache.current.set(value)
    setListing(value)
    setDirectoryMessage('')
  }, [])
  const handleDirectoryError = useCallback((error: unknown) => {
    console.error('[VideoAutoCut] browse materials failed', error)
    setDirectoryMessage(DIRECTORY_LOAD_ERROR)
  }, [])
  const { loading, refresh: refreshDirectory } = useAsyncRefresh({
    load: loadDirectory,
    apply: applyDirectory,
    initialLoading: true,
    onError: handleDirectoryError,
  })

  const loadMaterialLibrary = useCallback(() => window.videoAutoCut.listMaterials(), [])
  const handleMaterialLibraryError = useCallback((error: unknown) => {
    console.error('[VideoAutoCut] list materials failed', error)
  }, [])
  const { refresh: refreshMaterialLibrary } = useAsyncRefresh({
    load: loadMaterialLibrary,
    apply: setLibrary,
    onError: handleMaterialLibraryError,
  })

  const syncCloud = useCallback(async () => {
    try {
      const current = await window.videoAutoCut.materialCloudStatus()
      setCloudStatus(current)
      if (!current.configured || !current.authenticated) return current
      const synced = await window.videoAutoCut.syncMaterialCloud()
      setCloudStatus(synced)
      return synced
    } catch (error) {
      console.error('[VideoAutoCut] sync material cloud failed', error)
      return null
    }
  }, [])

  const updateAutoSync = useCallback(async (enabled: boolean) => {
    if (autoSyncSaving) return
    const previous = autoSyncEnabled
    setAutoSyncEnabled(enabled)
    setAutoSyncSaving(true)
    try {
      const saved = await window.videoAutoCut.writeEnv({
        VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS: enabled ? 'true' : 'false',
      })
      const savedEnabled = saved.VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS?.trim() === 'true'
      setAutoSyncEnabled(savedEnabled)
      if (savedEnabled) {
        toast.success('已开启自动同步云端', {
          description: '素材先在本地完成分析，再备份视频和分析结果；关闭应用后下次继续。',
        })
        void syncCloud()
      } else {
        toast.success('已关闭自动同步云端', {
          description: '不会再自动上传新素材，正在执行的任务不受影响。',
        })
      }
    } catch (error) {
      console.error('[VideoAutoCut] update material auto sync failed', error)
      setAutoSyncEnabled(previous)
      toast.error('自动同步设置保存失败', { description: '请稍后重试。' })
    } finally {
      if (mountedRef.current) setAutoSyncSaving(false)
    }
  }, [autoSyncEnabled, autoSyncSaving, mountedRef, syncCloud])

  const refresh = useCallback(async () => {
    directoryCache.current.clear()
    await Promise.all([refreshDirectory(), refreshMaterialLibrary()])
    void syncCloud()
  }, [refreshDirectory, refreshMaterialLibrary, syncCloud])

  useEffect(() => {
    // A freshly installed device has no local catalog until cloud sync finishes.
    void syncCloud()
  }, [syncCloud])

  useEffect(() => {
    void window.videoAutoCut.readEnv().then((env) => {
      if (mountedRef.current) {
        setAutoSyncEnabled(env.VIDEOAUTO_MATERIAL_AUTO_BACKUP_IMPORTS?.trim() === 'true')
      }
    }).catch((error) => {
      console.error('[VideoAutoCut] read material auto sync setting failed', error)
    })
  }, [mountedRef])

  useEffect(() => {
    void window.videoAutoCut.materialCloudStatus().then(setCloudStatus).catch((error) => {
      console.error('[VideoAutoCut] read material cloud status failed', error)
    })
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      directoryCache.current.clear()
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void Promise.all([refreshDirectory(), refreshMaterialLibrary()]).catch(() => undefined)
      }, 300)
    }
    const unsubscribe = window.videoAutoCut.onMaterialLibraryEvent((event) => {
      if (event.type === 'cloud-progress' && ['upload', 'download'].includes(String(event.direction))) {
        const materialId = String(event.materialId || '')
        const bytesTransferred = Number(event.bytesTransferred)
        const totalBytes = Number(event.totalBytes)
        const speedBytesPerSecond = Number(event.speedBytesPerSecond)
        if (materialId && Number.isFinite(bytesTransferred) && Number.isFinite(totalBytes)) {
          const updateProgress = event.direction === 'download' ? setDownloadProgress : setUploadProgress
          updateProgress((current) => ({
            ...current,
            [materialId]: {
              bytesTransferred: Math.max(0, bytesTransferred),
              totalBytes: Math.max(0, totalBytes),
              speedBytesPerSecond: Number.isFinite(speedBytesPerSecond)
                ? Math.max(0, speedBytesPerSecond)
                : undefined,
            },
          }))
        }
      } else if (event.type === 'analysis-status' || (event.type.startsWith('cloud-') && !['cloud-sync-started', 'cloud-sync-progress', 'cloud-sync-settled', 'cloud-sync-failed'].includes(event.type)
        && !(event.type === 'cloud-sync-completed' && event.catalogChanged === false))) {
        scheduleRefresh()
      }
      if (event.type === 'cloud-upload-control') {
        const materialId = String(event.materialId || '')
        if (materialId) {
          setUploadProgress((current) => {
            const existing = current[materialId]
            return existing
              ? { ...current, [materialId]: { ...existing, speedBytesPerSecond: undefined } }
              : current
          })
        }
      }
      if (event.type === 'cloud-status' && event.status === 'failed') {
        const materialId = String(event.materialId || 'unknown')
        toast.error(event.direction === 'download' ? '素材下载失败' : '素材上传失败', {
          id: `material-${event.direction === 'download' ? 'download' : 'upload'}-failed-${materialId}`,
          description: String(event.message || '请检查网络连接后重试。'),
        })
      }
      if (event.type === 'cloud-analysis-status' && event.status === 'failed') {
        toast.error(event.direction === 'download' ? '分析索引恢复失败' : '分析结果同步失败', {
          id: `analysis-transfer-failed-${String(event.materialId || 'unknown')}`,
          description: `${String(event.message || '请稍后重试。')} 可在“更多操作”中重试，无需重新分析视频。`,
        })
      }
      if (event.type.startsWith('cloud-')) {
        if (event.cloud) setCloudStatus(event.cloud as MaterialCloudStatus)
      }
    })
    return () => { unsubscribe(); if (refreshTimer) clearTimeout(refreshTimer) }
  }, [refreshDirectory, refreshMaterialLibrary])

  const uploadProgressOverrides = useMemo<MaterialUiMetadataMap>(() => {
    const overrides: MaterialUiMetadataMap = {}
    for (const file of listing?.files || []) {
      if (!file.materialId) continue
      const progress = uploadProgress[file.materialId]
      const download = downloadProgress[file.materialId]
      if (!progress && !download) continue
      overrides[file.path] = {
        ...(progress ? {
          uploadBytesTransferred: progress.bytesTransferred,
          uploadTotalBytes: progress.totalBytes,
          uploadSpeedBytesPerSecond: progress.speedBytesPerSecond,
        } : {}),
        ...(download ? {
          downloadBytesTransferred: download.bytesTransferred,
          downloadTotalBytes: download.totalBytes,
          downloadSpeedBytesPerSecond: download.speedBytesPerSecond,
        } : {}),
      }
    }
    return overrides
  }, [downloadProgress, listing, uploadProgress])

  const resetFolderSearch = useCallback((clearInput: boolean) => {
    folderSearchRequestRef.current += 1
    if (clearInput) setSearchTextState('')
    setFolderSearchQuery('')
    setFolderSearchLoading(false)
    setFolderSearchMessage('')
    setFolderSearchResults([])
  }, [])

  const setSearchText = useCallback((value: string) => {
    setSearchTextState(value)
    if (searchMode === 'file') resetFolderSearch(false)
  }, [resetFolderSearch, searchMode])

  const setSearchMode = useCallback((value: SearchMode) => {
    if (value === searchMode) return
    resetFolderSearch(true)
    setSemanticMessage('')
    setSearchModeState(value)
  }, [resetFolderSearch, searchMode])

  const openFolder = useCallback((folderId: string) => {
    resetFolderSearch(true)
    setSearchModeState('file')
    if (folderId === currentFolderId) {
      void refreshDirectory().catch(() => undefined)
      return
    }
    setListing(directoryCache.current.get(folderId))
    setDirectoryMessage('')
    setCurrentFolderId(folderId)
  }, [currentFolderId, refreshDirectory, resetFolderSearch])

  async function importMaterials(
    selection: 'files' | 'folder' = 'files',
    targetFolder?: MaterialActionFolder,
  ) {
    if (importingMaterials) return
    const target = targetFolder || listing?.current
    if (target?.kind === 'cloud' || target?.canImport === false) {
      toast.info('云端素材不能直接导入', {
        description: '请先导入到本地素材，完成分析和上传后再进行云端整理。',
      })
      return
    }
    const folderId = target?.canImport ? target.id : undefined
    setImportingMaterials(true)
    try {
      const imported = await window.videoAutoCut.importMaterials(
        { ...(folderId ? { folderId } : {}), selection },
      )
      if (!hasImportedMaterials(imported)) return
      await refresh()
      toast.success(selection === 'folder' ? '文件夹已导入' : '素材已导入', {
        description: autoSyncEnabled
          ? '分析与云端同步会在后台继续执行。'
          : '分析会在后台继续，当前素材只保存在本机。',
      })
    } catch (error) {
      console.error('[VideoAutoCut] import materials failed', error)
      toast.error('导入素材失败', {
        description: error instanceof Error && error.message
          ? error.message
          : '请确认文件格式和存储空间后重试。',
      })
    } finally {
      if (mountedRef.current) setImportingMaterials(false)
    }
  }

  async function createMaterialFolder(name: string, targetFolder?: MaterialActionFolder) {
    const parent = targetFolder || listing?.current
    if (!parent?.canCreate || creatingFolder) return false

    setCreatingFolder(true)
    try {
      const result = await window.videoAutoCut.createMaterialFolder({
        parentFolderId: parent.id,
        name,
      })
      if (!reportOperationResult(result, '创建文件夹失败')) return false
      if (result.folder) {
        const createdFolder = result.folder
        setListing((current) => {
          if (!current || current.current.id !== parent.id) return current
          if (current.folders.some((folder) => folder.id === createdFolder.id)) return current
          return {
            ...current,
            current: {
              ...current.current,
              folderCount: (current.current.folderCount || current.folders.length) + 1,
            },
            folders: [...current.folders, createdFolder].sort((first, second) => (
              first.name.localeCompare(second.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
            )),
          }
        })
      }
      setFolderTreeRevision((revision) => revision + 1)
      void Promise.all([refreshDirectory(), refreshMaterialLibrary()])
      return true
    } catch (error) {
      console.error('[VideoAutoCut] create material folder failed', error)
      window.alert('创建文件夹失败，请稍后重试。')
      return false
    } finally {
      if (mountedRef.current) setCreatingFolder(false)
    }
  }

  async function runFolderSearch() {
    const request = createMaterialFolderSearchRequest(searchText)
    if (!request) {
      resetFolderSearch(false)
      return
    }

    const requestId = folderSearchRequestRef.current + 1
    folderSearchRequestRef.current = requestId
    setFolderSearchQuery(request.query)
    setFolderSearchLoading(true)
    setFolderSearchMessage('')
    setFolderSearchResults([])

    try {
      const results = await window.videoAutoCut.searchMaterialFolders(request)
      if (!mountedRef.current || folderSearchRequestRef.current !== requestId) return
      setFolderSearchResults(results)
    } catch (error) {
      console.error('[VideoAutoCut] search material folders failed', error)
      if (!mountedRef.current || folderSearchRequestRef.current !== requestId) return
      setFolderSearchMessage(FOLDER_SEARCH_ERROR)
    } finally {
      if (mountedRef.current && folderSearchRequestRef.current === requestId) setFolderSearchLoading(false)
    }
  }

  async function runSemanticSearch() {
    const query = searchText.trim()
    setSearchModeState('semantic')
    if (!query) {
      setSemanticResults([])
      setSemanticMessage('请输入要搜索的画面内容')
      return
    }

    setSemanticLoading(true)
    setSemanticMessage('')
    try {
      const result = await window.videoAutoCut.semanticSearchMaterials({ query, results: 20, threshold: 0, noTrim: true })
      setSemanticResults(result.results || [])
      if (!result.ok && !result.results.length) setSemanticMessage(SEMANTIC_SEARCH_ERROR)
      else if (!result.results.length) setSemanticMessage('没有匹配结果。请确认素材已经完成语义索引。')
    } catch (error) {
      console.error('[VideoAutoCut] semantic material search failed', error)
      setSemanticResults([])
      setSemanticMessage(SEMANTIC_SEARCH_ERROR)
    } finally {
      setSemanticLoading(false)
    }
  }

  function submitSearch() {
    if (searchMode === 'semantic') {
      void runSemanticSearch()
      return
    }
    void runFolderSearch()
  }

  function clearSearch() {
    if (searchMode === 'file') {
      resetFolderSearch(true)
      return
    }
    setSearchTextState('')
    setSemanticMessage('')
    setSemanticResults([])
  }

  async function deleteMaterial(item: Pick<FileItem, 'path' | 'name'>) {
    if (deletingPaths.has(item.path)) return
    const displayName = basename(item.name, '未命名视频')
    const confirmed = confirmDestructiveAction(`确定删除素材「${displayName}」吗？\n\n会同步清理这个视频在向量数据库中的索引。`)
    if (!confirmed) return

    await runWithPending(item.path, async () => {
      const result = await window.videoAutoCut.deleteMaterial({ path: item.path })
      if (!reportOperationResult(result, '删除素材失败')) return
      setSemanticResults((items) => items.filter((semanticResult) => {
        const localPath = semanticResult.localPath || semanticResult.path
        return localPath.toLowerCase() !== item.path.toLowerCase()
      }))
      await refresh()
    })
  }

  async function deleteMaterialFiles(paths: string[]) {
    const uniquePaths = [...new Set(paths)]
    if (!uniquePaths.length || deletingBatch) return false
    setDeletingBatch(true)
    try {
      const result = await window.videoAutoCut.deleteMaterials({ paths: uniquePaths })
      const succeededPaths = new Set(
        result.results.filter((item) => item.ok).map((item) => item.path.toLocaleLowerCase()),
      )
      setSemanticResults((items) => items.filter((semanticResult) => {
        const localPath = semanticResult.localPath || semanticResult.path
        return !succeededPaths.has(localPath.toLocaleLowerCase())
      }))
      await refresh()
      if (result.failed > 0) {
        const details = result.results
          .filter((item) => !item.ok)
          .slice(0, 3)
          .map((item) => `${basename(item.path, '未命名素材')}：${item.message || '删除失败'}`)
          .join('\n')
        window.alert(`${result.message || '部分素材删除失败'}${details ? `\n\n${details}` : ''}`)
      }
      return result.succeeded > 0
    } catch (error) {
      console.error('[VideoAutoCut] batch delete materials failed', error)
      window.alert('删除素材失败，请稍后重试。')
      return false
    } finally {
      if (mountedRef.current) setDeletingBatch(false)
    }
  }

  async function renameMaterial(item: Pick<FileItem, 'path' | 'name'>, name: string) {
    if (renamingPaths.has(item.path) || deletingPaths.has(item.path)) return false

    const renamed = await runRenameWithPending(item.path, async () => {
      const result = await window.videoAutoCut.renameMaterial({ path: item.path, name })
      if (!reportOperationResult(result, '重命名素材失败')) return false

      setSemanticResults((items) => items.filter((semanticResult) => {
        const localPath = semanticResult.localPath || semanticResult.path
        return localPath.toLowerCase() !== item.path.toLowerCase()
      }))
      await refresh()
      return true
    })
    return renamed ?? false
  }

  async function analyzeMaterial(item: Pick<FileItem, 'path' | 'materialId'>) {
    if (analyzingPaths.has(item.path)) return
    const toastId = toast.loading('正在提交素材分析')
    try {
      await runAnalysisWithPending(item.path, async () => {
        const result = await window.videoAutoCut.analyzeMaterial({ path: item.path, materialId: item.materialId })
        if (!result.ok) {
          toast.error('素材分析失败', { id: toastId, description: result.message || '请稍后重试。' })
          return
        }
        toast.success('素材分析已完成', { id: toastId })
        await refresh()
      })
    } catch (error) {
      console.error('[VideoAutoCut] analyze material failed', error)
      toast.error('素材分析失败', { id: toastId, description: '请稍后重试。' })
    }
  }

  async function uploadMaterials(paths: string[]) {
    const uniquePaths = [...new Set(paths)]
    if (!uniquePaths.length) return
    const current = cloudStatus || await window.videoAutoCut.materialCloudStatus()
    setCloudStatus(current)
    if (!current.configured) {
      toast.warning('尚未配置云素材服务', { description: '当前素材仍安全保存在本地。' })
      return
    }
    if (!current.authenticated) {
      toast.error('登录已失效', { description: '请重新登录后再上传云端。' })
      return
    }
    const toastId = toast.loading(`正在加入 ${uniquePaths.length} 个素材到同步队列`)
    try {
      const queuedRequest = window.videoAutoCut.uploadMaterialsToCloud({ paths: uniquePaths })
      const results = await Promise.all(uniquePaths.map((item) => (
        runUploadWithPending(item, () => queuedRequest)
      )))
      const result = results.find(Boolean) || await queuedRequest
      setCloudStatus(result.status)
      await refreshDirectory()
      if (!result.queued) {
        toast.warning('没有可上传的素材', {
          id: toastId,
          description: result.skipped
            ? '所选素材可能已在云端、已被移动，或本机文件不可用，请刷新后重试。'
            : '请选择本机可用的素材后重试。',
        })
      } else {
        toast.success(`已加入 ${result.queued} 个素材到云端同步队列`, {
          id: toastId,
          description: result.skipped
            ? `${result.skipped} 个素材已跳过；上传会在后台继续。`
            : '可以继续使用软件，上传会在后台完成。',
        })
      }
    } catch (error) {
      console.error('[VideoAutoCut] queue cloud upload failed', error)
      toast.error('加入云端同步队列失败', { id: toastId, description: '请稍后重试。' })
    }
  }

  async function moveMaterialFiles(
    paths: string[],
    sourceFolderId: string,
    destinationFolderId: string,
  ) {
    const uniquePaths = [...new Set(paths)]
    if (!uniquePaths.length || movingMaterials) return false
    setMovingMaterials(true)
    const toastId = toast.loading(`正在移动 ${uniquePaths.length} 个素材`)
    try {
      const result = await window.videoAutoCut.moveMaterials({
        paths: uniquePaths,
        sourceFolderId,
        destinationFolderId,
      })
      if (!result.ok) {
        toast.error('移动素材失败', { id: toastId, description: result.message || '请稍后重试。' })
        return false
      }
      setSemanticResults([])
      await refresh()
      toast.success(`已移动 ${result.moved ?? uniquePaths.length} 个素材`, { id: toastId })
      return true
    } catch (error) {
      console.error('[VideoAutoCut] move materials failed', error)
      toast.error('移动素材失败', { id: toastId, description: '请稍后重试。' })
      return false
    } finally {
      if (mountedRef.current) setMovingMaterials(false)
    }
  }

  async function moveMaterialFolder(folder: MaterialActionFolder, destinationFolderId: string) {
    if (folder.canRename !== true || movingMaterials) return false
    setMovingMaterials(true)
    try {
      const result = await window.videoAutoCut.moveMaterialFolder({
        folderId: folder.id,
        destinationFolderId,
      })
      if (!reportOperationResult(result, '移动素材文件夹失败')) return false
      setFolderSearchResults([])
      setSemanticResults([])
      setFolderTreeRevision((revision) => revision + 1)
      await refresh()
      return true
    } catch (error) {
      console.error('[VideoAutoCut] move material folder failed', error)
      window.alert('移动素材文件夹失败，请稍后重试。')
      return false
    } finally {
      if (mountedRef.current) setMovingMaterials(false)
    }
  }

  async function controlMaterialUpload(
    item: Pick<FileItem, 'path' | 'name' | 'materialId'>,
    action: 'pause' | 'resume' | 'cancel',
  ) {
    if (!item.materialId || uploadingPaths.has(item.path)) return
    if (action === 'cancel') {
      const displayName = basename(item.name, '未命名视频')
      const confirmed = confirmDestructiveAction(
        `确定取消素材「${displayName}」的上传吗？\n\n已上传的云端分片会被清理，本地文件和分析结果都会保留。`,
      )
      if (!confirmed) return
    }
    await runUploadWithPending(item.path, async () => {
      const result = await window.videoAutoCut.controlMaterialCloudUpload({
        materialId: item.materialId || '',
        action,
      })
      setCloudStatus(result.status)
      if (!result.ok) window.alert(result.message || '上传操作失败，请稍后重试。')
      await refreshDirectory()
    })
  }

  async function downloadMaterial(item: Pick<FileItem, 'path' | 'materialId'>) {
    if (!item.materialId || downloadingPaths.has(item.path)) return
    await runDownloadWithPending(item.path, async () => {
      const result = await window.videoAutoCut.downloadMaterialFromCloud({ materialId: item.materialId || '' })
      if (!result.ok) {
        window.alert(result.message || '下载云端素材失败。')
        return
      }
      await refreshDirectory()
    })
  }

  async function deleteCloudCopy(
    item: Pick<FileItem, 'path' | 'name' | 'materialId' | 'localStatus' | 'cloudStatus'>,
  ) {
    if (!item.materialId || cloudDeletingPaths.has(item.path)) return
    if (item.localStatus !== 'present' || item.cloudStatus !== 'ready') return
    const displayName = basename(item.name, '未命名视频')
    const confirmed = confirmDestructiveAction(
      `确定删除素材「${displayName}」的云端视频副本吗？\n\n本地文件、本地分析结果和素材记录都会保留。`,
    )
    if (!confirmed) return
    await runCloudDeleteWithPending(item.path, async () => {
      const result = await window.videoAutoCut.deleteMaterialCloudCopy({
        materialId: item.materialId || '',
      })
      setCloudStatus(result.status)
      if (!result.ok) {
        window.alert(result.message || '删除云端副本失败。')
        return
      }
      await refreshDirectory()
    })
  }

  async function deleteLocalCopy(
    item: Pick<FileItem, 'path' | 'name' | 'materialId' | 'localStatus' | 'cloudStatus'>,
  ) {
    if (!item.materialId || localDeletingPaths.has(item.path)) return
    if (item.localStatus !== 'present' || item.cloudStatus !== 'ready') return
    const displayName = basename(item.name, '未命名视频')
    const confirmed = confirmDestructiveAction(
      `确定删除素材「${displayName}」的本机副本吗？\n\n云端素材、分析结果和分镜绑定都会保留，之后可以重新下载。`,
    )
    if (!confirmed) return
    await runLocalDeleteWithPending(item.path, async () => {
      const result = await window.videoAutoCut.deleteMaterialLocalCopy({ materialId: item.materialId || '' })
      if (!reportOperationResult(result, '删除本机副本失败')) return
      await refreshDirectory()
    })
  }

  async function publishMaterial(item: Pick<FileItem, 'path' | 'name' | 'materialId'>) {
    if (!item.materialId || publicationPendingPaths.has(item.path)) return
    const displayName = basename(item.name, '未命名视频')
    const confirmed = window.confirm(
      `申请公开素材「${displayName}」吗？\n\n提交即表示你确认拥有该视频的合法权利，并同意平台审核和公开展示。`,
    )
    if (!confirmed) return
    await runPublicationWithPending(item.path, async () => {
      const result = await window.videoAutoCut.publishMaterial({ materialId: item.materialId || '' })
      if (!reportOperationResult(result, '申请公开素材失败')) return
      await refreshDirectory()
    })
  }

  async function withdrawPublication(item: Pick<FileItem, 'path' | 'name' | 'materialId'>) {
    if (!item.materialId || publicationPendingPaths.has(item.path)) return
    const displayName = basename(item.name, '未命名视频')
    const confirmed = confirmDestructiveAction(
      `确定取消素材「${displayName}」的公开状态吗？\n\n私有素材和云端备份都会保留。`,
    )
    if (!confirmed) return
    await runPublicationWithPending(item.path, async () => {
      const result = await window.videoAutoCut.withdrawMaterialPublication({
        materialId: item.materialId || '',
        reason: '用户主动取消公开',
      })
      if (!reportOperationResult(result, '取消公开素材失败')) return
      await refreshDirectory()
    })
  }

  async function deleteMaterialFolder(folder: MaterialActionFolder, confirmed = false) {
    if (folder.canDelete !== true || deletingPaths.has(folder.id)) return false
    const displayName = basename(folder.name, '未命名文件夹')
    const affectsCurrentDirectory = listing?.breadcrumbs.some((item) => item.id === folder.id) === true
    if (!confirmed) {
      const accepted = confirmDestructiveAction(
        folder.kind === 'cloud'
          ? `确定删除云端文件夹「${displayName}」吗？\n\n只删除目录关系和数据库记录，COS 中的真实素材文件会保留。`
          : `确定删除文件夹「${displayName}」及其中全部素材吗？\n\n会同步清理这些视频在向量数据库中的索引。`,
      )
      if (!accepted) return false
    }

    const deleted = await runWithPending(folder.id, async () => {
      const result = await window.videoAutoCut.deleteMaterialFolder({ folderId: folder.id })
      if (!result.ok) {
        toast.error('删除文件夹失败', { description: result.message || '请稍后重试。' })
        return false
      }

      setFolderSearchResults((items) => (
        items.filter((searchResult) => searchResult.folder.id !== folder.id)
      ))
      setSemanticResults([])
      setListing((current) => current ? {
        ...current,
        current: {
          ...current.current,
          folderCount: Math.max(0, (current.current.folderCount || current.folders.length) - (
            current.folders.some((item) => item.id === folder.id) ? 1 : 0
          )),
        },
        rootFolders: (current.rootFolders || []).filter((item) => item.id !== folder.id),
        folders: current.folders.filter((item) => item.id !== folder.id),
      } : current)
      setFolderTreeRevision((revision) => revision + 1)
      if (affectsCurrentDirectory && result.parentId) {
        setCurrentFolderId(result.parentId)
      } else {
        void refreshDirectory()
      }
      void refreshMaterialLibrary()
      toast.success('删除成功')
      return true
    })
    return deleted ?? false
  }

  async function renameMaterialFolder(folder: MaterialActionFolder, name: string) {
    if (
      folder.canRename !== true
      || renamingPaths.has(folder.id)
      || deletingPaths.has(folder.id)
  ) return false

    const affectsCurrentDirectory = listing?.breadcrumbs.some((item) => item.id === folder.id) === true
    const renamed = await runRenameWithPending(folder.id, async () => {
      const result = await window.videoAutoCut.renameMaterialFolder({ folderId: folder.id, name })
      if (!reportOperationResult(result, '重命名文件夹失败')) return false

      if (result.folder) {
        const renamedFolder = result.folder
        setFolderSearchResults((items) => items.flatMap((searchResult) => {
          if (searchResult.folder.id !== folder.id) return [searchResult]
          if (
            folderSearchQuery
            && !renamedFolder.name.toLocaleLowerCase().includes(folderSearchQuery.toLocaleLowerCase())
          ) return []
          return [{ ...searchResult, folder: renamedFolder }]
        }))
      }
      setSemanticResults([])
      setFolderTreeRevision((revision) => revision + 1)
      if (affectsCurrentDirectory && result.folder) {
        setCurrentFolderId(result.folder.id)
        await refreshMaterialLibrary()
      } else {
        await refresh()
      }
      return true
    })
    return renamed ?? false
  }

  function deleteMaterialTarget(target: MaterialActionTarget) {
    if (target.type === 'file') {
      void deleteMaterial(target.file)
      return
    }
    void deleteMaterialFolder(target.folder)
  }

  function deleteCloudCopyTarget(target: MaterialActionTarget) {
    if (target.type === 'file') void deleteCloudCopy(target.file)
  }

  function deleteLocalCopyTarget(target: MaterialActionTarget) {
    if (target.type === 'file') void deleteLocalCopy(target.file)
  }

  function publishMaterialTarget(target: MaterialActionTarget) {
    if (target.type === 'file') void publishMaterial(target.file)
  }

  function withdrawPublicationTarget(target: MaterialActionTarget) {
    if (target.type === 'file') void withdrawPublication(target.file)
  }

  function controlMaterialUploadTarget(
    target: MaterialActionTarget,
    action: 'pause' | 'resume' | 'cancel',
  ) {
    if (target.type === 'file') void controlMaterialUpload(target.file, action)
  }

  async function retryAnalysisTransferTarget(target: MaterialActionTarget, direction: 'upload' | 'download') {
    if (target.type !== 'file' || !target.file.materialId) return
    await runUploadWithPending(target.file.path, async () => {
      try {
        const result = await window.videoAutoCut.retryMaterialAnalysisTransfer({ materialId: target.file.materialId!, direction })
        if (!result.ok) { toast.error('未能加入分析同步队列', { description: result.message }); return }
        toast.success(direction === 'download' ? '已加入分析索引恢复队列' : '已加入分析结果同步队列', {
          description: '使用已有分析结果，无需重新分析视频。',
        })
        await Promise.all([refreshDirectory(), refreshMaterialLibrary()])
      } catch (error) {
        toast.error('未能加入分析同步队列', { description: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  function renameMaterialTarget(target: MaterialActionTarget, name: string) {
    return target.type === 'file'
      ? renameMaterial(target.file, name)
      : renameMaterialFolder(target.folder, name)
  }

  const allCards = useMemo(() => buildMaterialCards(library), [library])

  return {
    allCards,
    analyzeMaterial,
    analyzingPaths,
    autoSyncEnabled,
    autoSyncSaving,
    canCreateFolder: Boolean(listing && (listing.current.canCreate || listing.current.kind === null)),
    cloudStatus,
    cloudDeletingPaths,
    clearSearch,
    createMaterialFolder,
    controlMaterialUploadTarget,
    retryAnalysisTransferTarget,
    creatingFolder,
    canImportMaterials: !listing
      || listing.current.kind === null
      || listing.current.canImport === true,
    currentFolderName: listing?.current.name || '本地素材',
    deleteMaterialTarget,
    deleteMaterialFiles,
    deletingBatch,
    deleteCloudCopyTarget,
    deleteLocalCopyTarget,
    deletingPaths,
    directoryMessage,
    downloadMaterial,
    downloadingPaths,
    folderSearchActive: Boolean(folderSearchQuery),
    folderSearchLoading,
    folderSearchMessage,
    folderSearchResults,
    folderTreeRevision,
    importMaterials,
    importingMaterials,
    importProgress: materialImport.progress,
    cancelMaterialImport: materialImport.cancel,
    dismissMaterialImport: materialImport.dismiss,
    listing,
    localDeletingPaths,
    loading,
    moveMaterialFiles,
    moveMaterialFolder,
    movingMaterials,
    deleteMaterialFolderConfirmed: (folder: MaterialActionFolder) => deleteMaterialFolder(folder, true),
    openFolder,
    publicationPendingPaths,
    publishMaterialTarget,
    refresh,
    renameMaterialTarget,
    renamingPaths,
    searchMode,
    searchText,
    semanticLoading,
    semanticMessage,
    semanticResults,
    setSearchMode,
    setSearchText,
    syncCloud,
    uploadMaterials,
    uploadProgressOverrides,
    uploadingPaths,
    updateAutoSync,
    withdrawPublicationTarget,
    submitSearch,
  }
}
