import { CloseButton } from './CloseButton'
import { FileActionButton } from './FileActionButton'
import { SideDrawer } from './SideDrawer'

export function LogDrawer({
  open,
  title = '运行日志',
  subtitle,
  log,
  filePath,
  onClose,
}: {
  open: boolean
  title?: string
  subtitle?: string
  log: string
  filePath?: string
  onClose: () => void
}) {
  return <SideDrawer open={open} className="log-drawer-overlay" panelClassName="log-drawer-panel" onClose={onClose}>
    <div className="log-drawer-head">
      <div>
        <strong>{title}</strong>
        {subtitle ? <span title={subtitle}>{subtitle}</span> : null}
      </div>
      <CloseButton onClick={onClose} iconClassName="icon" />
    </div>
    {filePath ? <div className="log-drawer-actions">
      <FileActionButton file={filePath} kind="open" label="打开日志" />
      <FileActionButton file={filePath} kind="folder" label="打开目录" />
    </div> : null}
    <pre className="log-box log-drawer-content">{log || '暂无日志'}</pre>
  </SideDrawer>
}
