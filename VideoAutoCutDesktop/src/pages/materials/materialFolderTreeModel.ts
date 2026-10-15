import type { MaterialDirectoryListing, MaterialFolderNode } from '../../types/videoauto'

export type MaterialFolderTreeItem = {
  id: string
  name: string
  folder: MaterialFolderNode
  children: MaterialFolderTreeItem[]
  hasChildren: boolean
  loaded: boolean
}

function treeItem(
  folder: MaterialFolderNode,
  children: MaterialFolderTreeItem[] = [],
  loaded = false,
): MaterialFolderTreeItem {
  return {
    id: folder.id,
    name: folder.name,
    folder,
    children,
    hasChildren: children.length > 0 || (folder.folderCount || 0) > 0,
    loaded,
  }
}

function findTreeItem(
  items: MaterialFolderTreeItem[],
  folderId: string,
): MaterialFolderTreeItem | undefined {
  for (const item of items) {
    if (item.id === folderId) return item
    const nested = findTreeItem(item.children, folderId)
    if (nested) return nested
  }
  return undefined
}

function hydrateTreeItem(
  tree: MaterialFolderTreeItem[],
  listing: MaterialDirectoryListing,
): void {
  const target = findTreeItem(tree, listing.current.id)
  if (!target) return
  if (listing.current.kind === null) {
    target.folder = listing.current
    target.name = listing.current.name
    target.children = []
    target.hasChildren = false
    target.loaded = true
    return
  }
  const existingChildren = new Map(target.children.map((child) => [child.id, child]))
  target.folder = listing.current
  target.name = listing.current.name
  target.children = listing.folders.map((folder) => {
    const existing = existingChildren.get(folder.id)
    if (!existing) return treeItem(folder)
    existing.folder = folder
    existing.name = folder.name
    existing.hasChildren = existing.children.length > 0 || (folder.folderCount || 0) > 0
    return existing
  })
  target.hasChildren = target.children.length > 0 || (listing.current.folderCount || 0) > 0
  target.loaded = true
}

export function buildMaterialFolderTree(
  listing: MaterialDirectoryListing,
  cachedListings: readonly MaterialDirectoryListing[] = [],
): MaterialFolderTreeItem[] {
  const rootBreadcrumb = listing.breadcrumbs[0]
  if (!rootBreadcrumb) return []

  const rootFolders = listing.rootFolders || listing.folders.filter((folder) => (
    folder.kind === 'user' || folder.kind === 'cloud' || folder.kind === 'raw'
  ))
  const knownFolders = new Map<string, MaterialFolderNode>([
    ...rootFolders.map((folder) => [folder.id, folder] as const),
    ...listing.folders.map((folder) => [folder.id, folder] as const),
    [listing.current.id, listing.current] as const,
  ])
  const folderForBreadcrumb = (id: string, name: string): MaterialFolderNode => (
    knownFolders.get(id) || {
      id,
      name,
      kind: null,
      canCreate: false,
      canRename: false,
      canDelete: false,
    }
  )
  const rootFolder = listing.root || (listing.current.id === rootBreadcrumb.id
    ? listing.current
    : {
        id: rootBreadcrumb.id,
        name: rootBreadcrumb.name,
        kind: null,
        canCreate: false,
        canRename: false,
        canDelete: false,
        folderCount: rootFolders.length,
        videoCount: rootFolders.reduce((total, folder) => total + (folder.videoCount || 0), 0),
      })
  const rootItem = treeItem(rootFolder, [], true)
  rootItem.hasChildren = false
  const tree = [rootItem, ...rootFolders.map((folder) => treeItem(folder))]

  if (listing.current.id !== rootItem.id) {
    const branchBreadcrumbs = listing.breadcrumbs.filter((breadcrumb) => breadcrumb.id !== rootItem.id)
    const branchRoot = branchBreadcrumbs[0]
    let parent = branchRoot ? findTreeItem(tree, branchRoot.id) : undefined
    for (const breadcrumb of branchBreadcrumbs) {
      if (!parent) break
      if (breadcrumb.id === parent.id) {
        if (breadcrumb.id === listing.current.id) {
          parent.folder = listing.current
          parent.name = listing.current.name
          parent.children = listing.folders
            .filter((folder) => !rootFolders.some((root) => root.id === folder.id))
            .map((folder) => treeItem(folder))
          parent.hasChildren = parent.children.length > 0 || (listing.current.folderCount || 0) > 0
          parent.loaded = true
        }
        continue
      }
      let child = parent.children.find((item) => item.id === breadcrumb.id)
      if (!child) {
        child = treeItem(folderForBreadcrumb(breadcrumb.id, breadcrumb.name))
        parent.children.push(child)
        parent.hasChildren = true
      }

      if (breadcrumb.id === listing.current.id) {
        child.folder = listing.current
        child.name = listing.current.name
        child.children = listing.folders
          .filter((folder) => !rootFolders.some((root) => root.id === folder.id))
          .map((folder) => treeItem(folder))
        child.hasChildren = child.children.length > 0 || (listing.current.folderCount || 0) > 0
        child.loaded = true
      }
      parent = child
    }
  }

  for (const cached of [...cachedListings].sort((first, second) => (
    first.breadcrumbs.length - second.breadcrumbs.length
  ))) {
    hydrateTreeItem(tree, cached)
  }
  // Cached listings supply expansion structure, never override fresh counts.
  for (const folder of [rootFolder, ...rootFolders, ...listing.folders, listing.current]) {
    const item = findTreeItem(tree, folder.id)
    if (item) { item.folder = folder; item.name = folder.name }
  }
  return tree
}

export function materialFolderOpenState(listing: MaterialDirectoryListing): Record<string, boolean> {
  return Object.fromEntries(
    listing.breadcrumbs
      .filter((_, index) => index > 0 && index < listing.breadcrumbs.length - 1)
      .map((breadcrumb) => [breadcrumb.id, true]),
  )
}
