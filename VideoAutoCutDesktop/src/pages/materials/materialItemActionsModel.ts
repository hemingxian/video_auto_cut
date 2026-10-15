import { formatDate, formatSize } from '../../lib/format.ts'
import type { FileItem, MaterialFolderNode } from '../../types/videoauto'

export type MaterialActionFile = Pick<
  FileItem,
  'name' | 'path' | 'url' | 'size' | 'mtime' | 'materialId' | 'localStatus' | 'cloudStatus'
  | 'uploadTransferStatus' | 'analysisStatus' | 'cloudAnalysisStatus' | 'publicationStatus' | 'publicationId'
  | 'analysisTransferStatus' | 'analysisTransferDirection' | 'analysisTransferError'
> & {
  ext?: string
  canMove?: boolean
}

export type MaterialActionFolder = Pick<
  MaterialFolderNode,
  'id' | 'name' | 'kind' | 'storageScope' | 'folderCount' | 'videoCount'
  | 'canCreate' | 'canImport' | 'canRename' | 'canDelete'
>

export type MaterialActionTarget =
  | { type: 'file'; file: MaterialActionFile }
  | { type: 'folder'; folder: MaterialActionFolder }

export type MaterialMenuAction =
  | 'details'
  | 'create_folder'
  | 'import_files'
  | 'import_folder'
  | 'rename'
  | 'move'
  | 'pause_upload'
  | 'resume_upload'
  | 'cancel_upload'
  | 'sync_analysis'
  | 'restore_analysis'
  | 'publish'
  | 'withdraw_publication'
  | 'delete_local_copy'
  | 'delete_cloud_copy'
  | 'delete'

export type MaterialMenuRequest = {
  target: MaterialActionTarget
  x: number
  y: number
}

export type RequestMaterialActions = (target: MaterialActionTarget, x: number, y: number) => void
export type RequestMaterialPreview = (file: MaterialActionFile) => void

const MATERIAL_MENU_ITEMS: ReadonlyArray<{
  action: MaterialMenuAction
  label: string
}> = [
  { action: 'details', label: '查看详情' },
  { action: 'create_folder', label: '新建文件夹' },
  { action: 'import_files', label: '添加文件' },
  { action: 'import_folder', label: '添加文件夹' },
  { action: 'rename', label: '重命名' },
  { action: 'move', label: '移动到' },
  { action: 'pause_upload', label: '暂停上传' },
  { action: 'resume_upload', label: '继续上传' },
  { action: 'cancel_upload', label: '取消上传' },
  { action: 'sync_analysis', label: '同步分析结果' },
  { action: 'restore_analysis', label: '恢复分析索引' },
  { action: 'publish', label: '申请公开' },
  { action: 'withdraw_publication', label: '取消公开' },
  { action: 'delete_local_copy', label: '删除本机副本' },
  { action: 'delete_cloud_copy', label: '删除云端副本' },
  { action: 'delete', label: '删除' },
]

const MENU_MARGIN = 8
const MENU_WIDTH = 176
const MENU_VERTICAL_SPACE = 10
const MENU_ITEM_HEIGHT = 32

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function getMaterialMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  itemCount = 3,
) {
  const menuHeight = MENU_VERTICAL_SPACE + MENU_ITEM_HEIGHT * Math.max(1, itemCount)
  return {
    left: clamp(x, MENU_MARGIN, viewportWidth - MENU_WIDTH - MENU_MARGIN),
    top: clamp(y, MENU_MARGIN, viewportHeight - menuHeight - MENU_MARGIN),
  }
}

export function materialMenuItemsFor(target: MaterialActionTarget) {
  if (target.type === 'file') {
    return MATERIAL_MENU_ITEMS.filter((item) => {
      if (['create_folder', 'import_files', 'import_folder'].includes(item.action)) return false
      const transferStatus = target.file.uploadTransferStatus
        || (target.file.cloudStatus === 'failed' ? 'failed' : undefined)
      const hasLocalUpload = Boolean(target.file.materialId && target.file.localStatus === 'present')
      if (item.action === 'pause_upload') {
        return hasLocalUpload && ['queued', 'uploading'].includes(transferStatus || '')
      }
      if (item.action === 'resume_upload') {
        return hasLocalUpload && ['paused', 'failed'].includes(transferStatus || '')
      }
      if (item.action === 'cancel_upload') {
        return hasLocalUpload && ['queued', 'uploading', 'paused', 'failed'].includes(transferStatus || '')
      }
      if (item.action === 'sync_analysis' || item.action === 'restore_analysis') {
        if (!hasLocalUpload || target.file.cloudStatus !== 'ready'
          || target.file.analysisTransferStatus === 'processing'
          || (target.file.analysisTransferStatus === 'queued' && !target.file.analysisTransferError)) return false
        const transferFailed = target.file.analysisTransferStatus === 'failed' || Boolean(target.file.analysisTransferError)
        return item.action === 'sync_analysis'
          ? target.file.analysisStatus === 'ready' && (target.file.cloudAnalysisStatus !== 'ready'
            || (target.file.analysisTransferDirection === 'upload' && transferFailed))
          : target.file.cloudAnalysisStatus === 'ready' && (target.file.analysisStatus !== 'ready'
            || (target.file.analysisTransferDirection === 'download' && transferFailed))
      }
      if (item.action === 'move') return target.file.canMove === true
      if (item.action === 'delete_local_copy') {
        return Boolean(
          target.file.materialId
          && target.file.localStatus === 'present'
          && target.file.cloudStatus === 'ready'
        )
      }
      if (item.action === 'delete_cloud_copy') {
        return Boolean(
          target.file.materialId
          && target.file.localStatus === 'present'
          && target.file.cloudStatus === 'ready'
          && (!target.file.publicationStatus || ['private', 'removed'].includes(target.file.publicationStatus))
        )
      }
      if (item.action === 'publish') {
        return Boolean(
          target.file.materialId
          && target.file.cloudStatus === 'ready'
          && target.file.analysisStatus === 'ready'
          && target.file.cloudAnalysisStatus === 'ready'
          && (!target.file.publicationStatus || ['private', 'removed'].includes(target.file.publicationStatus))
        )
      }
      if (item.action === 'withdraw_publication') {
        return Boolean(
          target.file.publicationId
          && ['publishing', 'public', 'suspended'].includes(target.file.publicationStatus || '')
        )
      }
      return true
    })
  }
  return MATERIAL_MENU_ITEMS.filter((item) => (
    item.action === 'details'
    || (item.action === 'create_folder' && target.folder.canCreate === true)
    || (item.action === 'import_files' && target.folder.canImport === true)
    || (item.action === 'import_folder' && target.folder.canImport === true)
    || (item.action === 'rename' && target.folder.canRename === true)
    || (item.action === 'move' && target.folder.canRename === true)
    || (item.action === 'delete' && target.folder.canDelete === true)
  ))
}

export function materialTargetKey(target: MaterialActionTarget) {
  return target.type === 'file' ? target.file.path : target.folder.id
}

export function materialTargetName(target: MaterialActionTarget) {
  return target.type === 'file'
    ? target.file.name || '未命名视频'
    : target.folder.name || '未命名文件夹'
}

export function materialFileExtension(file: MaterialActionFile) {
  const extension = file.ext || file.name.match(/\.[^.]+$/)?.[0] || ''
  return extension.startsWith('.') ? extension : extension ? `.${extension}` : ''
}

export function materialRenameStem(file: MaterialActionFile) {
  const extension = materialFileExtension(file)
  if (!extension || !file.name.toLowerCase().endsWith(extension.toLowerCase())) return file.name
  return file.name.slice(0, -extension.length)
}

export function materialRenameValue(target: MaterialActionTarget) {
  return target.type === 'file' ? materialRenameStem(target.file) : materialTargetName(target)
}

export function validateMaterialRenameStem(
  value: string,
  targetType: MaterialActionTarget['type'] = 'file',
) {
  const targetName = targetType === 'folder' ? '文件夹' : '素材'
  const name = value.trim()
  if (!name) return `请输入${targetName}名称`
  if (name === '.' || name === '..') return `${targetName}名称无效`
  if ([...name].some((character) => character.charCodeAt(0) < 32) || /[<>:"/\\|?*]/.test(name)) {
    return '名称不能包含 \\ / : * ? " < > |'
  }
  if (/[. ]$/.test(name)) return '名称不能以空格或句点结尾'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return '该名称为系统保留名称'
  if (name.length > 180) return `${targetName}名称不能超过 180 个字符`
  return ''
}

function createMaterialFileDetails(file: MaterialActionFile) {
  const extension = materialFileExtension(file)
  return [
    { label: '名称', value: file.name || '未命名视频' },
    { label: '类型', value: '视频素材' },
    { label: '格式', value: extension ? extension.slice(1).toUpperCase() : '未知' },
    { label: '大小', value: formatSize(file.size) },
    { label: '修改时间', value: formatDate(file.mtime) },
  ]
}

export function createMaterialDetails(target: MaterialActionTarget) {
  if (target.type === 'file') return createMaterialFileDetails(target.file)
  return [
    { label: '名称', value: materialTargetName(target) },
    { label: '类型', value: '文件夹' },
    { label: '子文件夹', value: `${target.folder.folderCount ?? 0} 个` },
    { label: '视频', value: `${target.folder.videoCount ?? 0} 个` },
  ]
}
