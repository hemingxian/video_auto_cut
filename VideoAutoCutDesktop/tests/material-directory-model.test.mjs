import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  MATERIAL_FOLDER_SEARCH_LIMIT,
  createMaterialDirectoryItems,
  createMaterialFolderSearchRequest,
  formatDirectoryContents,
  hasDirectoryContents,
} from '../src/pages/materials/materialDirectoryModel.ts'
import {
  formatVideoDuration,
  videoPreviewSeekTime,
} from '../src/pages/materials/videoPreviewModel.ts'
import {
  analysisLabel,
  hasImportedMaterials,
  hasReusableMaterialAnalysis,
  materialFilterCounts,
  materialMatchesFilter,
  materialMetadataFor,
  materialBackupStateFor,
  materialBackupLabel,
  materialDownloadProgressPercent,
  materialSelectionAfterPageToggle,
  materialSelectionAfterToggle,
  materialUploadProgressPercent,
  storageLabel,
  visibleMaterialFiles,
} from '../src/pages/materials/materialLibraryUiModel.ts'

test('cloud backup completion requires both the video and its analysis, with recoverable local preparation states', () => {
  const base = { path: 'local.mp4', localStatus: 'present', cloudStatus: 'not_uploaded', analysisStatus: 'pending' }
  assert.equal(materialBackupStateFor(base), undefined)
  assert.equal(materialBackupStateFor({ ...base, uploadTransferStatus: 'queued' }), 'waiting_analysis')
  assert.equal(materialBackupStateFor({ ...base, uploadTransferStatus: 'queued', analysisStatus: 'analyzing' }), 'analyzing')
  assert.equal(materialBackupStateFor({ ...base, uploadTransferStatus: 'queued', analysisStatus: 'failed' }), 'analysis_failed')
  for (const uploadTransferStatus of ['paused', 'canceled']) {
    assert.equal(materialBackupStateFor({ ...base, uploadTransferStatus, analysisStatus: 'analyzing' }), uploadTransferStatus)
  }
  assert.equal(materialBackupStateFor({ ...base, analysisStatus: 'ready', cloudStatus: 'ready' }), 'syncing_analysis')
  assert.equal(materialBackupStateFor({ ...base, localStatus: 'missing', cloudStatus: 'ready' }), 'incomplete')
  assert.equal(materialBackupStateFor({ ...base, analysisStatus: 'ready', cloudAnalysisStatus: 'ready', uploadTransferStatus: 'queued' }), 'queued')
  assert.equal(materialBackupStateFor({ ...base, cloudStatus: 'ready', cloudAnalysisStatus: 'ready' }), 'ready')
  assert.equal(materialBackupLabel('ready'), '云备份完成')
  assert.equal(materialBackupStateFor({ ...base, cloudStatus: 'ready', cloudAnalysisStatus: 'ready', analysisTransferStatus: 'failed' }), 'ready')
})

test('cloud analysis is reusable without a local index, but cloud storage alone is not analysis', () => {
  const file = { path: 'cloud.mp4', localStatus: 'missing', analysisStatus: 'pending', cloudStatus: 'ready', cloudAnalysisStatus: 'ready' }
  assert.equal(hasReusableMaterialAnalysis(file), true)
  assert.equal(materialMetadataFor(file).analysis, 'ready')
  assert.equal(materialMatchesFilter(materialMetadataFor(file), 'pending'), false)
  assert.equal(file.analysisStatus, 'pending')
  for (const cloudAnalysisStatus of ['pending', 'analyzing', 'failed', undefined]) {
    assert.equal(hasReusableMaterialAnalysis({ ...file, cloudAnalysisStatus }), false)
  }
  assert.equal(hasReusableMaterialAnalysis({ ...file, cloudStatus: 'failed' }), false)
  assert.equal(hasReusableMaterialAnalysis({ ...file, analysisStatus: 'failed' }), true)
})

test('analysis transfer failures remain visible without invalidating uploaded files or valid analysis', () => {
  const base = { path: 'local.mp4', localStatus: 'present', cloudStatus: 'ready', analysisStatus: 'ready' }
  for (const status of ['failed', 'queued']) {
    const metadata = materialMetadataFor({ ...base, analysisTransferStatus: status, analysisTransferError: 'analysis API HTTP 503' })
    assert.equal(metadata.analysis, 'ready')
    assert.equal(metadata.storage, 'both')
    assert.equal(materialMatchesFilter(metadata, 'sync_failed'), true)
    assert.equal(materialMatchesFilter(metadata, 'local'), true)
    assert.equal(materialMatchesFilter(metadata, 'cloud'), true)
  }
  for (const status of ['queued', 'processing', 'ready']) {
    assert.equal(materialMatchesFilter(materialMetadataFor({ ...base, analysisTransferStatus: status }), 'sync_failed'), false)
  }
})

test('upload failures preserve local visibility while a deliberate pause is not a sync failure', () => {
  const file = { path: 'local.mp4', localStatus: 'present', cloudStatus: 'failed' }
  const failed = materialMetadataFor(file)
  assert.equal(materialMatchesFilter(failed, 'local'), true)
  assert.equal(materialMatchesFilter(failed, 'sync_failed'), true)
  const paused = materialMetadataFor({ ...file, uploadTransferStatus: 'paused' })
  assert.equal(materialMatchesFilter(paused, 'local'), true)
  assert.equal(materialMatchesFilter(paused, 'sync_failed'), false)
  const missing = materialMetadataFor({ ...file, localStatus: 'missing' })
  assert.equal(materialMatchesFilter(missing, 'local'), false)
})
import {
  MATERIAL_UI_RESPONSE_BUDGET_MS,
  materialUiResponseMeasurement,
} from '../src/pages/materials/materialUiPerformance.ts'
import {
  buildMaterialFolderTree,
  materialFolderOpenState,
} from '../src/pages/materials/materialFolderTreeModel.ts'

test('material-library UI measurements enforce the 200ms painted-response budget', () => {
  assert.deepEqual(materialUiResponseMeasurement('filter', 100, 245), {
    interaction: 'filter',
    duration: 145,
    budget: MATERIAL_UI_RESPONSE_BUDGET_MS,
    withinBudget: true,
  })
  assert.equal(materialUiResponseMeasurement('pagination', 100, 301).withinBudget, false)
})

test('material import only reports success when at least one file was imported', async () => {
  assert.equal(hasImportedMaterials([]), false)
  assert.equal(hasImportedMaterials([{}]), true)

  const libraryHook = await readFile(
    new URL('../src/pages/materials/useMaterialsLibrary.ts', import.meta.url),
    'utf8',
  )
  assert.match(libraryHook, /if \(!hasImportedMaterials\(imported\)\) return/)
})

test('material-library filtering stays within the 200ms budget for 5,000 records', () => {
  const listing = {
    current: { name: '素材库' },
    files: Array.from({ length: 5_000 }, (_, index) => ({
      name: `material-${index}.mp4`,
      path: `material-${index}.mp4`,
      localStatus: index % 3 === 0 ? 'missing' : 'present',
      cloudStatus: index % 2 === 0 ? 'ready' : undefined,
      analysisStatus: index % 5 === 0 ? 'pending' : 'ready',
    })),
  }
  const startedAt = performance.now()
  const counts = materialFilterCounts(listing)
  const cloudFiles = visibleMaterialFiles(listing, 'cloud')
  const duration = performance.now() - startedAt

  assert.equal(counts.all, 5_000)
  assert.equal(cloudFiles.length, 2_500)
  assert.ok(duration <= MATERIAL_UI_RESPONSE_BUDGET_MS, `filtering took ${duration.toFixed(1)}ms`)
})

test('folder search requests contain only a normalized folder-name query', () => {
  assert.deepEqual(createMaterialFolderSearchRequest('  产品演示  '), {
    query: '产品演示',
    limit: MATERIAL_FOLDER_SEARCH_LIMIT,
  })
  assert.equal(createMaterialFolderSearchRequest('   '), null)
})

test('fresh root and scope counts override expanded folder cache without adding overlapping sets', () => {
  const root = { id: 'root', name: '素材库', kind: null, videoCount: 14 }
  const local = { id: 'local', name: '本地素材', kind: 'user', videoCount: 4 }
  const cloud = { id: 'cloud', name: '云端素材', kind: 'cloud', videoCount: 12 }
  const listing = { root, current: cloud, rootFolders: [local, cloud], folders: [], files: [], breadcrumbs: [{id:'root',name:'素材库'},{id:'cloud',name:'云端素材'}] }
  const stale = {...listing, current:{...cloud,videoCount:30}}
  const tree = buildMaterialFolderTree(listing, [stale])
  assert.equal(tree[0].folder.videoCount, 14)
  assert.equal(tree[1].folder.videoCount, 4)
  assert.equal(tree[2].folder.videoCount, 12)
})

test('directory summaries distinguish direct folders and videos', () => {
  assert.equal(formatDirectoryContents({ folders: [{ id: 'folder' }], files: [{ name: 'video' }] }), '1 个文件夹 · 1 个视频')
})

test('directory content state only depends on direct child folders and videos', () => {
  assert.equal(hasDirectoryContents(null), false)
  assert.equal(hasDirectoryContents({ folders: [], files: [] }), false)
  assert.equal(hasDirectoryContents({ folders: [{ id: 'folder' }], files: [] }), true)
  assert.equal(hasDirectoryContents({ folders: [], files: [{ name: 'video' }] }), true)
})

test('React Arborist folder data preserves the active hierarchy and direct children', () => {
  const root = { id: 'root', name: '素材库', kind: null, canCreate: false, canRename: false, canDelete: false }
  const user = { id: 'user', name: '本地素材', kind: 'user', canCreate: true, canRename: false, canDelete: false }
  const downloads = { id: 'downloads', name: '云端素材', kind: 'cloud', canCreate: true, canRename: false, canDelete: false }
  const current = { id: 'campaign', name: '投放项目', kind: 'user', canCreate: true, canRename: true, canDelete: true }
  const child = { id: 'episode', name: '第一集', kind: 'user', canCreate: true, canRename: true, canDelete: true }
  const listing = {
    current,
    breadcrumbs: [root, user, current].map(({ id, name }) => ({ id, name })),
    rootFolders: [user, downloads],
    folders: [child],
    files: [],
  }

  const [treeRoot, treeUser, treeDownloads] = buildMaterialFolderTree(listing)
  assert.equal(treeRoot.id, root.id)
  assert.deepEqual(treeRoot.children, [])
  assert.equal(treeUser.id, user.id)
  assert.equal(treeDownloads.id, downloads.id)
  assert.equal(treeUser.children[0].id, current.id)
  assert.equal(treeUser.children[0].children[0].id, child.id)
  assert.deepEqual(materialFolderOpenState(listing), { user: true })
  assert.deepEqual(materialFolderOpenState({ ...listing, current: root, breadcrumbs: [root] }), {})

  const sibling = { ...current, id: 'archive', name: '历史项目' }
  const withCachedLocalRoot = buildMaterialFolderTree(listing, [{
    current: user,
    breadcrumbs: [root, user].map(({ id, name }) => ({ id, name })),
    rootFolders: [user, downloads],
    folders: [current, sibling],
    files: [],
  }])
  assert.deepEqual(
    withCachedLocalRoot.find((item) => item.id === user.id).children.map((item) => item.id),
    [current.id, sibling.id],
  )
})

test('icon items always place folders before videos without flattening metadata into labels', () => {
  const folder = { id: 'folder', name: '项目素材' }
  const video = { name: '片段.mp4', path: 'internal-only' }
  const items = createMaterialDirectoryItems({ folders: [folder], files: [video] })

  assert.deepEqual(items.map((item) => item.type), ['folder', 'video'])
  assert.equal(items[0].folder, folder)
  assert.equal(items[1].file, video)
})

test('raw material helpers hide indexed copies and resolve semantic results to source videos', async () => {
  const {
    findOriginalMaterialFile,
    isIndexedMaterialCopy,
    listOriginalMaterialFiles,
  } = await import('../dist-electron/materials-service.js')
  const shotDirectory = path.resolve('workspace', 'runs', 'run-1', 'raw', 'shot_001')
  const first = { name: 'alpha.mov', path: path.join(shotDirectory, 'alpha.mov') }
  const second = { name: 'beta.mp4', path: path.join(shotDirectory, 'beta.mp4') }
  const indexed = {
    name: '002_beta.mp4',
    path: path.join(shotDirectory, '_indexed_h264', '002_beta.mp4'),
  }

  assert.equal(isIndexedMaterialCopy(indexed), true)
  assert.deepEqual(listOriginalMaterialFiles([first, indexed, second]), [first, second])
  assert.equal(findOriginalMaterialFile(indexed, [second, first])?.path, second.path)
  assert.equal(findOriginalMaterialFile({
    name: '999_alpha.mp4',
    path: path.join(shotDirectory, '_indexed_h264', '999_alpha.mp4'),
  }, [second, first])?.path, first.path)
})

test('materials page exposes local and cloud materials without task output actions', async () => {
  const [page, service, cards, libraryHook, createDialog, importMenu] = await Promise.all([
    readFile(new URL('../src/pages/MaterialsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../electron/materials-service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/materialCards.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/useMaterialsLibrary.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialFolderCreateDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialImportMenu.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(page, /openFolderPath\(appInfo\.materialsDir\)/)
  assert.match(page, />素材目录</)
  assert.match(page, />新建文件夹</)
  assert.match(page, /<MaterialImportMenu/)
  assert.match(importMenu, />添加素材</)
  assert.match(importMenu, />选择文件</)
  assert.match(importMenu, />选择文件夹</)
  assert.match(importMenu, />按原目录结构批量导入视频</)
  assert.match(page, /materials\.canCreateFolder/)
  assert.doesNotMatch(page, /GenerateMaterialPanel|SideDrawer|生成素材|generatePanel/)
  assert.match(service, /listOriginalMaterialFiles/)
  assert.match(service, /INDEX_DIRECTORY_NAME\s*=\s*'_indexed_h264'/)
  assert.match(cards, /library\.user/)
  assert.doesNotMatch(cards, /run\.clips|run\.finalClips/)
  assert.match(libraryHook, /listing\.current\.canCreate \|\| listing\.current\.kind === null/)
  assert.match(libraryHook, /target\?\.canImport \? target\.id/)
  assert.match(libraryHook, /canImportMaterials:/)
  assert.match(
    libraryHook,
    /importMaterials\(\s*\{ \.\.\.\(folderId \? \{ folderId \} : \{\}\), selection \},\s*\)/,
  )
  assert.match(libraryHook, /createMaterialFolder\(\{\s*parentFolderId:\s*parent\.id,\s*name,/s)
  assert.match(createDialog, /createPortal/)
  assert.match(createDialog, /role="dialog"/)
  assert.match(createDialog, /validateMaterialRenameStem\(name,\s*'folder'\)/)
})

test('lazy preview timing formats known duration and seeks safely near the first frame', () => {
  assert.equal(formatVideoDuration(0), '')
  assert.equal(formatVideoDuration(Number.NaN), '')
  assert.equal(formatVideoDuration(65.9), '1:05')
  assert.equal(formatVideoDuration(3661), '1:01:01')
  assert.equal(videoPreviewSeekTime(0), 0)
  assert.equal(videoPreviewSeekTime(0.05), 0.04)
  assert.equal(videoPreviewSeekTime(12), 0.08)
})

test('material library filters and selection use explicit UI states', () => {
  const localPending = {
    analysis: 'pending',
    storage: 'local',
    visibility: 'private',
  }
  const cloudReady = {
    analysis: 'ready',
    storage: 'cloud',
    visibility: 'public',
  }

  assert.equal(materialMatchesFilter(localPending, 'local'), true)
  assert.equal(materialMatchesFilter(localPending, 'pending'), true)
  assert.equal(materialMatchesFilter(localPending, 'cloud'), false)
  assert.equal(materialMatchesFilter(cloudReady, 'cloud'), true)
  assert.equal(analysisLabel('processing'), '分析中')
  assert.equal(storageLabel('sync_failed'), '同步失败')
  assert.equal(storageLabel('local'), '本地')
  assert.equal(storageLabel('cloud'), '云端')
  assert.equal(materialUploadProgressPercent({ uploadBytesTransferred: 50, uploadTotalBytes: 200 }), 25)
  assert.equal(materialUploadProgressPercent({ uploadBytesTransferred: 250, uploadTotalBytes: 200 }), 100)
  assert.equal(materialUploadProgressPercent({ uploadBytesTransferred: 0, uploadTotalBytes: 0 }), undefined)
  assert.equal(materialDownloadProgressPercent({ downloadBytesTransferred: 3, downloadTotalBytes: 4 }), 75)

  const counts = materialFilterCounts({
    current: { name: '产品素材' },
    files: [
      { path: 'local-pending.mp4', localStatus: 'present', analysisStatus: 'pending' },
      { path: 'both-ready.mp4', localStatus: 'present', cloudStatus: 'ready', analysisStatus: 'ready' },
      { path: 'cloud-ready.mp4', localStatus: 'missing', cloudStatus: 'ready', analysisStatus: 'ready' },
      { path: 'sync-failed.mp4', localStatus: 'present', cloudStatus: 'failed', analysisStatus: 'ready' },
    ],
  })
  assert.deepEqual(counts, {
    all: 4,
    local: 3,
    cloud: 2,
    sync_failed: 1,
    pending: 1,
  })

  const selected = materialSelectionAfterToggle(new Set(), 'video-a')
  assert.deepEqual([...selected], ['video-a'])
  assert.equal(materialSelectionAfterToggle(selected, 'video-a').size, 0)

  const selectedPage = materialSelectionAfterPageToggle(
    new Set(['outside-page']),
    ['video-a', 'video-b', 'video-b'],
  )
  assert.deepEqual([...selectedPage], ['outside-page', 'video-a', 'video-b'])
  assert.deepEqual(
    [...materialSelectionAfterPageToggle(selectedPage, ['video-a', 'video-b'])],
    ['outside-page'],
  )
})

test('material directory views never render file paths as visible or accessible text', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/pages/MaterialsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialDirectoryView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialVideoGridItem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/SemanticResults.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialItemActionLayer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialVideoPreviewDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialMediaPlayer.tsx', import.meta.url), 'utf8'),
  ])

  for (const source of sources) {
    assert.doesNotMatch(source, /(?:description|title|aria-label)=\{[^}\n]*(?:\.path|relativePath)/)
    assert.doesNotMatch(source, /displayPath|semanticRaw/)
  }

  const directoryView = sources[1]
  const searchResultsView = directoryView.slice(
    directoryView.indexOf('function FolderSearchResults'),
    directoryView.indexOf('export function MaterialDirectoryView'),
  )
  assert.doesNotMatch(searchResultsView, /breadcrumbs|\.path|relativePath/)
  assert.match(directoryView, /className="material-icon-grid"/)
  assert.match(directoryView, /<FolderClosed className="material-browser-icon folder"/)
  assert.match(directoryView, /className="material-browser-icon folder"/)
  assert.match(directoryView, /type:\s*'folder'/)
  assert.match(directoryView, /onContextMenu=/)
  assert.match(directoryView, /aria-haspopup=\{onRequestActions \? 'menu'/)
  assert.doesNotMatch(directoryView, /<table|<th|material-details|DirectoryMaterialCard|VideoCard|video-thumb/)

  const videoItem = sources[2]
  assert.match(videoItem, /preload="metadata"/)
  assert.match(videoItem, /onClick=\{\(\) => onPreview\(item\)\}/)
  assert.match(videoItem, /onContextMenu=/)
  assert.match(videoItem, /event\.preventDefault\(\)/)
  assert.match(videoItem, /event\.key !== 'ContextMenu'/)
  assert.doesNotMatch(videoItem, /Trash2|Pause|material-icon-delete|close-button|onDoubleClick|scheduleToggle/)
  assert.doesNotMatch(videoItem, /title=/)

  const semanticResults = sources[3]
  assert.match(semanticResults, /showOpenFolderAction=\{false\}/)
  assert.match(semanticResults, /onContextMenu=/)
  assert.doesNotMatch(semanticResults, /deleteAction|topActions=/)

  const actionLayer = sources[4]
  assert.match(actionLayer, /role="menu"/)
  assert.match(actionLayer, /role="menuitem"/)
  assert.match(actionLayer, /validateMaterialRenameStem/)
  assert.match(actionLayer, /createMaterialDetails/)
  assert.match(actionLayer, /materialMenuItemsFor\(request\.target\)/)

  const previewDialog = sources[5]
  assert.match(previewDialog, /createPortal/)
  assert.match(previewDialog, /role="dialog"/)
  assert.match(previewDialog, /aria-modal="true"/)
  assert.match(previewDialog, /autoPlay/)
  assert.match(previewDialog, /MaterialMediaPlayer/)
  assert.match(previewDialog, /event\.key === 'Escape'/)
  assert.doesNotMatch(previewDialog, /(?:title|aria-label|description)=\{[^}\n]*\.path/)

  const mediaPlayer = sources[6]
  assert.match(mediaPlayer, /MediaControlBar/)
  assert.match(mediaPlayer, /MediaPlayButton/)
  assert.match(mediaPlayer, /MediaTimeRange/)
  assert.match(mediaPlayer, /MediaVolumeRange/)
  assert.match(mediaPlayer, /MediaFullscreenButton/)
  assert.match(mediaPlayer, /playsInline/)

  const [workspace, folderTree] = await Promise.all([
    readFile(new URL('../src/pages/materials/MaterialLibraryWorkspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/materials/MaterialFolderTree.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(workspace, /aria-label="返回上级"/)
  assert.match(workspace, /aria-label="返回素材库"/)
  assert.match(workspace, /listing\.current\.name/)
  assert.match(workspace, /<MaterialFolderTree/)
  assert.match(workspace, /key=\{`\$\{rootBreadcrumb\?\.id \|\| 'root'\}:\$\{folderTreeRevision\}`\}/)
  assert.doesNotMatch(workspace, /key=\{`\$\{listing\.current\.id\}:/)
  assert.match(workspace, /const \[focusedPath, setFocusedPath\]/)
  assert.match(workspace, /fileByPath\.get\(focusedPath\)/)
  assert.match(workspace, /setFocusedPath\(file\.path\)/)
  assert.match(folderTree, /from 'react-arborist'/)
  assert.match(folderTree, /openByDefault=\{false\}/)
  assert.match(folderTree, /onContextMenu=/)
  assert.match(folderTree, /event\.key === 'F2'/)
  assert.match(folderTree, /event\.key === 'ContextMenu'/)
  assert.match(folderTree, /onClick=/)
  assert.doesNotMatch(folderTree, /onDoubleClick=/)
  assert.doesNotMatch(folderTree, /material-library-local-summary/)
  assert.doesNotMatch(folderTree, /ancestor'/)
  assert.match(folderTree, /\[listing\.current\.id\]: listing/)
  assert.match(folderTree, /disableDrag=/)
  assert.match(folderTree, /disableDrop=/)
  assert.match(folderTree, /onRequestActions\(\{ type: 'folder', folder \}/)
  assert.doesNotMatch(folderTree, /material-library-folder-more/)
})

test('video previews activate once through IntersectionObserver and release pending interaction', async () => {
  const hook = await readFile(new URL('../src/pages/materials/useLazyVideoPreview.ts', import.meta.url), 'utf8')

  assert.match(hook, /new IntersectionObserver/)
  assert.match(hook, /entry\.isIntersecting/)
  assert.match(hook, /setActivated\(true\)/)
  assert.match(hook, /observer\.disconnect\(\)/)
  assert.match(hook, /videoPreviewSeekTime/)
  assert.doesNotMatch(hook, /scheduleToggle|pendingPlayRef|\.play\(\)/)
})

test('material folder icons use neutral colors without yellow or gold styling', async () => {
  const styles = await readFile(new URL('../src/styles/layout-refinements.css', import.meta.url), 'utf8')
  const folderRule = styles.match(/\.material-browser-icon\.folder\s*\{[^}]+\}/s)?.[0] || ''

  assert.match(folderRule, /color:\s*#8491a3/)
  assert.doesNotMatch(folderRule, /#c7a65d|yellow|gold/i)
  assert.match(styles, /\.material-icon-grid\s*\{[^}]*minmax\(108px,\s*120px\)/s)
  assert.match(styles, /\.material-browser-icon\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*stroke-width:\s*1\.1/s)
  assert.match(styles, /\.material-icon-visual\s*\{[^}]*width:\s*88px;[^}]*height:\s*50px/s)

  const hoverRule = styles.match(/\.material-icon-main:hover\s*\{[^}]+\}/s)?.[0] || ''
  assert.match(hoverRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.025\)/)
  assert.doesNotMatch(hoverRule, /border-color|box-shadow|transform/)
  assert.doesNotMatch(styles, /\.material-icon-delete/)

  const menuHoverRule = styles.match(/\.material-context-menu-item:hover,[\s\S]*?\{[^}]+\}/)?.[0] || ''
  assert.match(menuHoverRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.055\)/)
  assert.doesNotMatch(menuHoverRule, /box-shadow|transform/)
  assert.match(styles, /\.material-video-preview-dialog\s*\{[^}]*width:\s*min\(920px,\s*100%\)/s)
  assert.match(styles, /\.material-video-preview-stage video\s*\{[^}]*object-fit:\s*contain/s)
  assert.doesNotMatch(styles, /material-details-(?:table|row|name|icon|delete)/)
})

test('material folder tree truncates long names without hiding video counts', async () => {
  const [folderTree, styles] = await Promise.all([
    readFile(new URL('../src/pages/materials/MaterialFolderTree.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/material-library-components.css', import.meta.url), 'utf8'),
  ])

  assert.match(folderTree, /className="material-library-folder-name" title=\{folderName\}/)
  assert.match(folderTree, /className="material-library-folder-count"/)
  assert.match(styles, /\.material-library-arborist-tree \[role="treeitem"\]\s*\{[^}]*min-width:\s*0\s*!important/s)
  assert.match(styles, /\.material-library-folder-row > \.material-library-folder-name\s*\{[^}]*text-overflow:\s*ellipsis/s)
  assert.match(styles, /\.material-library-folder-row > \.material-library-folder-count\s*\{[^}]*justify-self:\s*end/s)
})

test('material cards keep their title and status in layout after window resizing', async () => {
  const styles = await readFile(new URL('../src/styles/material-library-components.css', import.meta.url), 'utf8')
  const gridRule = styles.match(/\.material-library-grid\s*\{[^}]+\}/s)?.[0] || ''
  const cardRules = [...styles.matchAll(/\.material-library-card\s*\{[^}]+\}/gs)]
    .map((match) => match[0])
    .join('\n')

  assert.match(gridRule, /grid-auto-rows:\s*max-content/)
  assert.match(cardRules, /display:\s*flex/)
  assert.match(cardRules, /flex-direction:\s*column/)
  assert.doesNotMatch(styles, /content-visibility|contain-intrinsic-size/)
})
