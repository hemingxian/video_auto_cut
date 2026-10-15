import { ChevronDown, FileVideo2, FolderUp, Upload } from 'lucide-react'
import * as DropdownMenu from 'radix-ui/dropdown-menu'

export function MaterialImportMenu({
  disabled,
  onImportFiles,
  onImportFolder,
}: {
  disabled: boolean
  onImportFiles: () => void
  onImportFolder: () => void
}) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button
        aria-label="添加素材"
        className="button primary material-import-trigger"
        disabled={disabled}
        type="button"
      >
        <Upload className="button-icon" />
        <span>添加素材</span>
        <ChevronDown className="material-import-trigger-chevron" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        className="material-import-menu-content"
        sideOffset={7}
      >
        <DropdownMenu.Item
          className="material-import-menu-item"
          onSelect={() => onImportFiles()}
        >
          <span className="material-import-menu-icon"><FileVideo2 /></span>
          <span className="material-import-menu-copy">
            <strong>选择文件</strong>
            <small>选择一个或多个视频</small>
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Separator className="material-import-menu-separator" />
        <DropdownMenu.Item
          className="material-import-menu-item"
          onSelect={() => onImportFolder()}
        >
          <span className="material-import-menu-icon"><FolderUp /></span>
          <span className="material-import-menu-copy">
            <strong>选择文件夹</strong>
            <small>按原目录结构批量导入视频</small>
          </span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
