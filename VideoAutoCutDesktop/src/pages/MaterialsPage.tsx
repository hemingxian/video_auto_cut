import { AlertTriangle, FolderOpen, FolderPlus, Globe2, RefreshCw } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { PageLayout } from '../components/common/PageLayout'
import { openFolderPath } from '../components/common/fileActions'
import type { AppInfo } from '../types/app'
import { MaterialDirectoryView } from './materials/MaterialDirectoryView'
import { MaterialDeleteDialog, type MaterialDeleteRequest } from './materials/MaterialDeleteDialog'
import { MaterialFolderCreateDialog } from './materials/MaterialFolderCreateDialog'
import { MaterialItemActionLayer } from './materials/MaterialItemActionLayer'
import { MaterialImportProgressDialog } from './materials/MaterialImportProgressDialog'
import { MaterialImportMenu } from './materials/MaterialImportMenu'
import { MaterialLibraryToolbar } from './materials/MaterialLibraryToolbar'
import { MaterialLibraryWorkspace } from './materials/MaterialLibraryWorkspace'
import { MaterialMoveDialog } from './materials/MaterialMoveDialog'
import { MaterialVideoPreviewDialog } from './materials/MaterialVideoPreviewDialog'
import { PublicMaterialDialog } from './materials/PublicMaterialDialog'
import { SemanticResults } from './materials/SemanticResults'
import type {
  MaterialLibraryFilter,
  MaterialLibraryViewMode,
} from './materials/materialLibraryUiModel'
import { materialFilterCounts } from './materials/materialLibraryUiModel'
import type {
  MaterialActionFolder,
  MaterialActionFile,
  MaterialActionTarget,
  MaterialMenuRequest,
  RequestMaterialActions,
} from './materials/materialItemActionsModel'
import { materialTargetName } from './materials/materialItemActionsModel'
import { useMaterialsLibrary } from './materials/useMaterialsLibrary'

export function MaterialsPage({ appInfo }: { appInfo: AppInfo | null }) {
  const materials = useMaterialsLibrary()
  const [materialMenu, setMaterialMenu] = useState<MaterialMenuRequest | null>(null)
  const [previewFile, setPreviewFile] = useState<MaterialActionFile | null>(null)
  const [createFolderParent, setCreateFolderParent] = useState<MaterialActionFolder | null>(null)
  const [publicMaterialsOpen, setPublicMaterialsOpen] = useState(false)
  const [moveRequest, setMoveRequest] = useState<
    | { kind: 'files'; paths: string[]; sourceFolderId: string; label: string; destinationKind: 'user'; destinationStorageScope: 'user' }
    | { kind: 'folder'; folder: Extract<MaterialActionTarget, { type: 'folder' }>['folder']; sourceFolderId: string; label: string; destinationKind: 'user' | 'cloud'; destinationStorageScope?: 'user' | 'downloads' }
    | null
  >(null)
  const [deleteRequest, setDeleteRequest] = useState<MaterialDeleteRequest | null>(null)
  const [activeFilter, setActiveFilter] = useState<MaterialLibraryFilter>('all')
  const [viewMode, setViewMode] = useState<MaterialLibraryViewMode>('grid')
  const filterCounts = useMemo(
    () => materialFilterCounts(materials.listing, materials.uploadProgressOverrides),
    [materials.listing, materials.uploadProgressOverrides],
  )
  const currentFolderId = materials.listing?.current.id || ''
  const currentFolderKind = materials.listing?.current.kind
  const requestMaterialActions = useCallback<RequestMaterialActions>((target, x, y) => {
    const canMoveFile = materials.searchMode === 'file'
      && !materials.folderSearchActive
      && currentFolderKind === 'user'
    setMaterialMenu({
      target: target.type === 'file'
        ? { type: 'file', file: { ...target.file, canMove: canMoveFile } }
        : target,
      x,
      y,
    })
  }, [currentFolderKind, materials.folderSearchActive, materials.searchMode])
  const closeMaterialMenu = useCallback(() => setMaterialMenu(null), [])

  const requestMoveTarget = useCallback((target: MaterialActionTarget) => {
    if (target.type === 'file') {
      if (!currentFolderId || target.file.canMove !== true) return
      setMoveRequest({
        kind: 'files',
        paths: [target.file.path],
        sourceFolderId: currentFolderId,
        label: materialTargetName(target),
        destinationKind: 'user',
        destinationStorageScope: 'user',
      })
      return
    }
    if (target.folder.canRename !== true) return
    setMoveRequest({
      kind: 'folder',
      folder: target.folder,
      sourceFolderId: target.folder.id,
      label: materialTargetName(target),
      destinationKind: target.folder.kind === 'cloud' ? 'cloud' : 'user',
      destinationStorageScope: target.folder.storageScope === 'downloads' ? 'downloads' : 'user',
    })
  }, [currentFolderId])

  const requestDeleteTarget = useCallback((target: MaterialActionTarget) => {
    if (target.type === 'file') {
      setDeleteRequest({ kind: 'files', paths: [target.file.path], label: materialTargetName(target) })
      return
    }
    if (target.folder.canDelete !== true) return
    setDeleteRequest({ kind: 'folder', folder: target.folder, label: materialTargetName(target) })
  }, [])

  return <PageLayout
    className="materials-page"
    bodyClassName="no-scroll"
    title="素材库"
    action={<div className="material-page-header">
      <div className="material-page-title">
        <h1>素材库</h1>
      </div>
      <div className="button-row">
        <button className="button" onClick={materials.refresh}><RefreshCw className="button-icon" />刷新</button>
        {appInfo ? <button className="button" onClick={() => openFolderPath(appInfo.materialsDir)}><FolderOpen className="button-icon" />素材目录</button> : null}
        {materials.canCreateFolder
          ? <button className="button" onClick={() => setCreateFolderParent(materials.listing?.current || null)}><FolderPlus className="button-icon" />新建文件夹</button>
          : null}
        <button className="button" onClick={() => setPublicMaterialsOpen(true)}><Globe2 className="button-icon" />公共素材</button>
        <MaterialImportMenu
          disabled={materials.importingMaterials || !materials.canImportMaterials}
          onImportFiles={() => { void materials.importMaterials('files') }}
          onImportFolder={() => { void materials.importMaterials('folder') }}
        />
      </div>
    </div>}
  >
    <div className="materials-surface">
      <MaterialLibraryToolbar
        activeFilter={activeFilter}
        autoSyncEnabled={materials.autoSyncEnabled}
        autoSyncSaving={materials.autoSyncSaving}
        busy={materials.searchMode === 'semantic' ? materials.semanticLoading : materials.folderSearchLoading}
        filterCounts={filterCounts}
        folderSearchActive={materials.folderSearchActive}
        onAutoSyncChange={(enabled) => { void materials.updateAutoSync(enabled) }}
        onClearSearch={materials.clearSearch}
        onFilterChange={setActiveFilter}
        onSearchModeChange={materials.setSearchMode}
        onSearchTextChange={materials.setSearchText}
        onSubmitSearch={materials.submitSearch}
        onViewModeChange={setViewMode}
        searchMode={materials.searchMode}
        searchText={materials.searchText}
        viewMode={viewMode}
      />

      {materials.cloudStatus?.syncing || materials.cloudStatus?.lastError ? <div className="material-cloud-conflict" role="status">
        <AlertTriangle />
        <span>
          <strong>{materials.cloudStatus.syncing ? '正在加载云端素材…' : '云端素材列表同步未完成'}</strong>
          <em>{materials.cloudStatus.syncing
            ? `${materials.cloudStatus.progress?.phase || '正在连接云端'}${materials.cloudStatus.progress?.total ? `：${materials.cloudStatus.progress.completed} / ${materials.cloudStatus.progress.total}` : '…'}`
            : materials.cloudStatus.lastError}</em>
        </span>
        <button className="button" type="button" disabled={materials.cloudStatus.syncing}
          onClick={() => { void materials.refresh() }}>重新同步</button>
      </div> : null}

      {materials.cloudStatus?.conflicts ? <div className="material-cloud-conflict" role="status">
        <AlertTriangle />
        <span>
          <strong>检测到 {materials.cloudStatus.conflicts} 项多设备修改冲突</strong>
          <em>已保留本机版本，云端版本没有覆盖当前修改。</em>
        </span>
        <button
          className="button"
          type="button"
          disabled={materials.cloudStatus.syncing}
          onClick={() => { void materials.refresh() }}
        >{materials.cloudStatus.syncing ? '正在同步' : '重新同步'}</button>
      </div> : null}

      <div className="material-browser">
        {materials.searchMode === 'file' && !materials.folderSearchActive
          ? <MaterialLibraryWorkspace
            showRootFiles={Boolean(materials.searchText.trim())}
            listing={materials.listing}
            folderTreeRevision={materials.folderTreeRevision}
            metadataOverrides={materials.uploadProgressOverrides}
            loading={materials.loading}
            message={materials.directoryMessage}
            activeFilter={activeFilter}
            viewMode={viewMode}
            onCreateFolder={materials.canCreateFolder ? () => setCreateFolderParent(materials.listing?.current || null) : undefined}
            onOpenFolder={materials.openFolder}
            onPreview={setPreviewFile}
            onRenameFolder={(folder, name) => materials.renameMaterialTarget({ type: 'folder', folder }, name)}
            onRequestActions={requestMaterialActions}
            onAnalyze={materials.analyzeMaterial}
            analyzingPaths={materials.analyzingPaths}
            onDownload={materials.downloadMaterial}
            downloadingPaths={materials.downloadingPaths}
            onDelete={(paths) => setDeleteRequest({
              kind: 'files',
              paths,
              label: paths.length === 1 ? '1 个素材' : `${paths.length} 个素材`,
            })}
            onDropMove={materials.moveMaterialFiles}
            onMoveFolder={materials.moveMaterialFolder}
            onMove={(paths) => {
              const sourceFolderId = materials.listing?.current.id
              if (!sourceFolderId || !paths.length) return
              setMoveRequest({
                kind: 'files',
                paths,
                sourceFolderId,
                label: paths.length === 1 ? '1 个素材' : `${paths.length} 个素材`,
                destinationKind: 'user',
                destinationStorageScope: 'user',
              })
            }}
            onUpload={materials.uploadMaterials}
            uploadingPaths={materials.uploadingPaths}
          />
          : <div className="material-results material-library-legacy-results">
            {materials.searchMode === 'file' ? <MaterialDirectoryView
              listing={materials.listing}
              loading={materials.loading}
              message={materials.directoryMessage}
              searchActive={materials.folderSearchActive}
              searchLoading={materials.folderSearchLoading}
              searchMessage={materials.folderSearchMessage}
              searchResults={materials.folderSearchResults}
              onOpenFolder={materials.openFolder}
              onPreview={setPreviewFile}
              onRequestActions={requestMaterialActions}
            /> : <>
            <div className="material-result-head">
              <strong>语义搜索结果</strong>
              <span>{materials.semanticResults.length} 个结果</span>
            </div>
            <SemanticResults
              results={materials.semanticResults}
              loading={materials.semanticLoading}
              message={materials.semanticMessage}
              allCards={materials.allCards}
              onPreview={setPreviewFile}
              onRequestActions={requestMaterialActions}
            />
            </>}
          </div>}
      </div>
    </div>

    <MaterialItemActionLayer
      request={materialMenu}
      deletingPaths={materials.deletingPaths}
      renamingPaths={materials.renamingPaths}
      cloudDeletingPaths={materials.cloudDeletingPaths}
      localDeletingPaths={materials.localDeletingPaths}
      uploadingPaths={materials.uploadingPaths}
      publicationPendingPaths={materials.publicationPendingPaths}
      onRequestClose={closeMaterialMenu}
      onCreateFolder={setCreateFolderParent}
      onImport={(folder, selection) => { void materials.importMaterials(selection, folder) }}
      onDelete={requestDeleteTarget}
      onDeleteLocalCopy={materials.deleteLocalCopyTarget}
      onDeleteCloudCopy={materials.deleteCloudCopyTarget}
      onPublish={materials.publishMaterialTarget}
      onWithdrawPublication={materials.withdrawPublicationTarget}
      onControlUpload={materials.controlMaterialUploadTarget}
      onRetryAnalysisTransfer={materials.retryAnalysisTransferTarget}
      onMove={requestMoveTarget}
      onRename={materials.renameMaterialTarget}
    />
    <MaterialVideoPreviewDialog
      key={previewFile?.path || 'closed'}
      file={previewFile}
      onClose={() => setPreviewFile(null)}
    />
    {createFolderParent ? <MaterialFolderCreateDialog
      parentName={createFolderParent.name || materials.currentFolderName}
      busy={materials.creatingFolder}
      onClose={() => setCreateFolderParent(null)}
      parents={createFolderParent.kind === null ? materials.listing?.rootFolders?.filter((folder) => folder.canCreate) : undefined}
      onCreate={(name, parentId) => materials.createMaterialFolder(name,
        materials.listing?.rootFolders?.find((folder) => folder.id === parentId) || createFolderParent)}
    /> : null}
    {publicMaterialsOpen ? <PublicMaterialDialog
      folderId={materials.canImportMaterials ? materials.listing?.current.id : undefined}
      folderName={materials.currentFolderName}
      onAdded={materials.refresh}
      onClose={() => setPublicMaterialsOpen(false)}
    /> : null}
    {moveRequest ? <MaterialMoveDialog
      blockedFolderId={moveRequest.kind === 'folder' ? moveRequest.folder.id : undefined}
      busy={materials.movingMaterials}
      count={moveRequest.kind === 'files' ? moveRequest.paths.length : 1}
      label={moveRequest.label}
      destinationKind={moveRequest.destinationKind}
      destinationStorageScope={moveRequest.destinationStorageScope}
      sourceFolderId={moveRequest.sourceFolderId}
      onClose={() => setMoveRequest(null)}
      onMove={(destinationFolderId) => moveRequest.kind === 'files'
        ? materials.moveMaterialFiles(moveRequest.paths, moveRequest.sourceFolderId, destinationFolderId)
        : materials.moveMaterialFolder(moveRequest.folder, destinationFolderId)}
    /> : null}
    {deleteRequest ? <MaterialDeleteDialog
      request={deleteRequest}
      busy={materials.deletingBatch || materials.deletingPaths.size > 0}
      onClose={() => setDeleteRequest(null)}
      onDelete={() => deleteRequest.kind === 'files'
        ? materials.deleteMaterialFiles(deleteRequest.paths)
        : materials.deleteMaterialFolderConfirmed(deleteRequest.folder)}
    /> : null}
    <MaterialImportProgressDialog
      progress={materials.importProgress}
      onCancel={() => { void materials.cancelMaterialImport() }}
      onClose={materials.dismissMaterialImport}
    />
  </PageLayout>
}
