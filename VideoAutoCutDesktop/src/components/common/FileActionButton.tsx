import { FileText, FolderOpen, PlayCircle } from 'lucide-react'
import { openContainingFolder, openFilePath } from './fileActions'

type FileActionKind = 'open' | 'play' | 'folder'

interface FileActionButtonProps {
  className?: string
  disabled?: boolean
  file: string
  kind: FileActionKind
  label?: string
  title?: string
}

function iconForKind(kind: FileActionKind) {
  if (kind === 'folder') return <FolderOpen className="action-icon" />
  if (kind === 'open') return <FileText className="action-icon" />
  return <PlayCircle className="action-icon" />
}

function defaultLabel(kind: FileActionKind): string {
  if (kind === 'folder') return '目录'
  if (kind === 'open') return '打开'
  return '播放'
}

export function FileActionButton({
  className,
  disabled = false,
  file,
  kind,
  label = defaultLabel(kind),
  title,
}: FileActionButtonProps) {
  const inactive = disabled || !file
  const onClick = () => {
    if (inactive) return
    if (kind === 'folder') {
      openContainingFolder(file)
      return
    }
    openFilePath(file)
  }

  return <button className={className} disabled={inactive} onClick={onClick} title={title}>
    {iconForKind(kind)}
    {label}
  </button>
}
