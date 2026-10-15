import { ChevronRight, FolderClosed, LoaderCircle, Plus } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  Tree,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from 'react-arborist'
import { toast } from 'sonner'

import { cx } from '../../lib/className'
import { basename } from '../../lib/path'
import type { MaterialDirectoryListing } from '../../types/videoauto'
import type {
  MaterialActionFolder,
  RequestMaterialActions,
} from './materialItemActionsModel'
import { useMaterialFolderDrop } from './materialDragAndDrop'
import {
  buildMaterialFolderTree,
  materialFolderOpenState,
  type MaterialFolderTreeItem,
} from './materialFolderTreeModel'

type MaterialFolderTreeContextValue = {
  loadingFolderIds: ReadonlySet<string>
  onDropFiles?: (paths: string[], sourceFolderId: string, destinationFolderId: string) => unknown | Promise<unknown>
  onOpenFolder: (folderId: string) => void
  onRequestActions: RequestMaterialActions
  onToggleFolder: (node: NodeApi<MaterialFolderTreeItem>) => void
}

const MaterialFolderTreeContext = createContext<MaterialFolderTreeContextValue | null>(null)

function FolderTreeRenameInput({ node }: NodeRendererProps<MaterialFolderTreeItem>) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return <input
    ref={inputRef}
    className="material-library-folder-rename"
    defaultValue={node.data.name}
    aria-label={`重命名 ${basename(node.data.name, '未命名文件夹')}`}
    onBlur={() => node.reset()}
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') node.reset()
      if (event.key === 'Enter') {
        event.preventDefault()
        void node.submit(inputRef.current?.value || '')
      }
    }}
  />
}

function MaterialFolderTreeNode(props: NodeRendererProps<MaterialFolderTreeItem>) {
  const { dragHandle, node, style } = props
  const context = useContext(MaterialFolderTreeContext)
  if (!context) throw new Error('MaterialFolderTreeNode must be rendered inside MaterialFolderTree')

  const { folder } = node.data
  const folderName = basename(node.data.name, '未命名文件夹')
  const handleDrop = useCallback((data: { paths: string[]; sourceFolderId: string }) => {
    return context.onDropFiles?.(data.paths, data.sourceFolderId, folder.id)
  }, [context, folder.id])
  const { dragOver, elementRef } = useMaterialFolderDrop({
    destinationFolderId: folder.id,
    enabled: folder.canImport === true && Boolean(context.onDropFiles),
    onDrop: handleDrop,
  })

  return <div
    ref={dragHandle}
    className="material-library-arborist-node"
    style={style}
  >
    <div
      ref={(element) => { elementRef.current = element }}
      className={cx(
        'material-library-folder-row',
        node.isSelected && 'active',
        dragOver && 'drop-target',
        node.isDragging && 'dragging',
      )}
      data-folder-id={folder.id}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        node.focus()
        context.onRequestActions({ type: 'folder', folder }, event.clientX, event.clientY)
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        node.focus()
        context.onOpenFolder(folder.id)
      }}
    >
      <button
        className={cx(
          'material-library-folder-toggle',
          node.isOpen && 'expanded',
          context.loadingFolderIds.has(folder.id) && 'loading',
        )}
        type="button"
        aria-label={node.isOpen ? `折叠 ${node.data.name}` : `展开 ${node.data.name}`}
        disabled={!node.data.hasChildren || context.loadingFolderIds.has(folder.id)}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          context.onToggleFolder(node)
        }}
      >
        {context.loadingFolderIds.has(folder.id)
          ? <LoaderCircle />
          : node.data.hasChildren ? <ChevronRight /> : null}
      </button>
      <FolderClosed />
      {node.isEditing
        ? <FolderTreeRenameInput {...props} />
        : <span className="material-library-folder-name" title={folderName}>{folderName}</span>}
      <em className="material-library-folder-count">{folder.videoCount ?? ''}</em>
    </div>
  </div>
}

export function MaterialFolderTree({
  listing,
  onCreateFolder,
  onDropFiles,
  onMoveFolder,
  onOpenFolder,
  onRenameFolder,
  onRequestActions,
}: {
  listing: MaterialDirectoryListing
  onCreateFolder?: () => void
  onDropFiles?: (paths: string[], sourceFolderId: string, destinationFolderId: string) => unknown | Promise<unknown>
  onMoveFolder?: (folder: MaterialActionFolder, destinationFolderId: string) => boolean | Promise<boolean>
  onOpenFolder: (folderId: string) => void
  onRenameFolder?: (folder: MaterialActionFolder, name: string) => boolean | Promise<boolean>
  onRequestActions: RequestMaterialActions
}) {
  const treeRef = useRef<TreeApi<MaterialFolderTreeItem> | undefined>(undefined)
  const treeHostRef = useRef<HTMLDivElement>(null)
  const loadingFolderIdsRef = useRef(new Set<string>())
  const pendingOpenFolderIdRef = useRef<string | null>(null)
  const [treeHeight, setTreeHeight] = useState(320)
  const [cachedListings, setCachedListings] = useState<Record<string, MaterialDirectoryListing>>({})
  const [loadingFolderIds, setLoadingFolderIds] = useState<ReadonlySet<string>>(() => new Set())
  const treeData = useMemo(
    () => buildMaterialFolderTree(listing, Object.values(cachedListings)),
    [cachedListings, listing],
  )
  const initialOpenState = useMemo(() => materialFolderOpenState(listing), [listing])
  const openFolder = useCallback((folderId: string) => {
    setCachedListings((current) => ({
      ...current,
      [listing.current.id]: listing,
    }))
    onOpenFolder(folderId)
  }, [listing, onOpenFolder])

  useEffect(() => {
    const host = treeHostRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setTreeHeight(Math.max(120, Math.floor(entry.contentRect.height)))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const folderId = pendingOpenFolderIdRef.current
    if (!folderId || !treeRef.current?.get(folderId)) return
    pendingOpenFolderIdRef.current = null
    treeRef.current.open(folderId)
  }, [treeData])

  const toggleFolder = useCallback(async (node: NodeApi<MaterialFolderTreeItem>) => {
    if (node.isOpen) {
      node.close()
      return
    }
    if (node.data.loaded) {
      node.open()
      return
    }
    if (loadingFolderIdsRef.current.has(node.id)) return

    loadingFolderIdsRef.current.add(node.id)
    setLoadingFolderIds(new Set(loadingFolderIdsRef.current))
    try {
      const loaded = await window.videoAutoCut.browseMaterials({ folderId: node.id })
      pendingOpenFolderIdRef.current = node.id
      setCachedListings((current) => ({ ...current, [node.id]: loaded }))
    } catch (error) {
      console.error('[VideoAutoCut] load material folder tree failed', error)
      toast.error('展开文件夹失败', { description: '请刷新素材库后重试。' })
    } finally {
      loadingFolderIdsRef.current.delete(node.id)
      setLoadingFolderIds(new Set(loadingFolderIdsRef.current))
    }
  }, [])

  const contextValue = useMemo<MaterialFolderTreeContextValue>(() => ({
    loadingFolderIds,
    onDropFiles,
    onOpenFolder: openFolder,
    onRequestActions,
    onToggleFolder: toggleFolder,
  }), [loadingFolderIds, onDropFiles, onRequestActions, openFolder, toggleFolder])

  function handleTreeKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement) return
    const focusedNode = treeRef.current?.focusedNode
    if (!focusedNode) return

    if (event.key === 'F2' && focusedNode.data.folder.canRename === true && onRenameFolder) {
      event.preventDefault()
      event.stopPropagation()
      void focusedNode.edit()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      openFolder(focusedNode.data.folder.id)
    } else if (
      (event.key === 'ArrowRight' || event.key === ' ')
      && focusedNode.data.hasChildren
      && !focusedNode.data.loaded
      && !focusedNode.isOpen
    ) {
      event.preventDefault()
      event.stopPropagation()
      void toggleFolder(focusedNode)
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      event.stopPropagation()
      const row = treeHostRef.current?.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(focusedNode.id)}"]`)
      const rect = row?.getBoundingClientRect()
      onRequestActions(
        { type: 'folder', folder: focusedNode.data.folder },
        rect ? rect.left + 28 : 24,
        rect ? rect.top + 28 : 24,
      )
    }
  }

  return <aside className="material-library-folders">
    <div className="material-library-panel-title">
      <strong>素材文件夹</strong>
      {onCreateFolder ? <button type="button" aria-label="新建文件夹" onClick={onCreateFolder}><Plus /></button> : null}
    </div>
    <div
      ref={treeHostRef}
      className="material-library-arborist-host"
      onKeyDownCapture={handleTreeKeyboard}
    >
      <MaterialFolderTreeContext.Provider value={contextValue}>
        <Tree<MaterialFolderTreeItem>
          ref={treeRef}
          className="material-library-arborist-tree"
          data={treeData}
          width="100%"
          height={treeHeight}
          rowHeight={43}
          indent={16}
          overscanCount={4}
          paddingBottom={6}
          selection={listing.current.id}
          initialOpenState={initialOpenState}
          openByDefault={false}
          disableMultiSelection
          disableDeselectOnClick
          disableEdit={(data) => data.folder.canRename !== true || !onRenameFolder}
          disableDrag={(data) => data.folder.canRename !== true || !onMoveFolder}
          disableDrop={({ parentNode, dragNodes }) => (
            !onMoveFolder
            || parentNode?.data.folder.canCreate !== true
            || dragNodes.some((node) => node.data.folder.canRename !== true)
            || dragNodes.every((node) => node.parent?.id === parentNode?.id)
          )}
          onRename={onRenameFolder ? async ({ name, node }) => {
            const renamed = await onRenameFolder(node.data.folder, name)
            if (renamed) setCachedListings({})
          } : undefined}
          onMove={onMoveFolder ? async ({ dragNodes, parentNode }) => {
            const dragged = dragNodes[0]
            const destination = parentNode?.data.folder
            if (!dragged || !destination || dragged.parent?.id === destination.id) return
            const moved = await onMoveFolder(dragged.data.folder, destination.id)
            if (moved) setCachedListings({})
          } : undefined}
        >
          {MaterialFolderTreeNode}
        </Tree>
      </MaterialFolderTreeContext.Provider>
    </div>
  </aside>
}
