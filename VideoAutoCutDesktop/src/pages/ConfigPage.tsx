import { CheckCircle2, HardDrive } from 'lucide-react'
import { Panel } from '../components/common/Panel'
import { PageLayout } from '../components/common/PageLayout'
import { UpdatesSection } from '../components/UpdatesSection'
import { cx } from '../lib/className'
import type { AppInfo } from '../types/app'
import { SettingRow } from './config/SettingRow'
import { VisualStylePanel } from './config/VisualStylePanel'
import { useConfigPageState } from './config/useConfigPageState'

export function ConfigPage({ appInfo }: { appInfo: AppInfo | null }) {
  const config = useConfigPageState(appInfo)

  return <PageLayout
    className="config-page"
    title="设置"
  >
    {config.saved ? <div className="saved-toast"><CheckCircle2 className="button-icon" />设置已自动保存</div> : null}
    <Panel className="storage-location-panel settings-panel">
      <div className="settings-heading">
        <div className="settings-icon"><HardDrive className="icon" /></div>
        <div>
          <h2>数据目录</h2>
          <p>运行环境、素材、历史任务、临时文件和默认成品输出的位置。</p>
        </div>
      </div>
      <div className="workspace-location-body">
        <SettingRow spec={config.workspaceSpec} value={config.values.VIDEOAUTO_WORKSPACE_DIR || ''} onChange={(value) => config.update('VIDEOAUTO_WORKSPACE_DIR', value)} />
      </div>
    </Panel>
    <div className="settings-grid">
      {config.groups.map((group) => {
        const Icon = group.icon
        const isVisualStyle = group.title === '画面样式'
        return <Panel key={group.title} className={cx('settings-panel', isVisualStyle && 'settings-panel-full')}>
          <div className="settings-heading">
            <div className="settings-icon"><Icon className="icon" /></div>
            <div>
              <h2>{group.title}</h2>
              <p>{group.description}</p>
            </div>
          </div>
          {isVisualStyle ? <VisualStylePanel values={config.values} onChange={config.update} /> : <div className="settings-list">
            {group.items.map((spec) => <SettingRow key={spec.key} spec={spec} value={config.values[spec.key] ?? ''} onChange={(value) => config.update(spec.key, value)} />)}
          </div>}
        </Panel>
      })}
    </div>
    <UpdatesSection appInfo={config.storageInfo} />
  </PageLayout>
}
