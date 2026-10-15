import { FileAudio, Mic2, Plus, RefreshCw, Terminal } from 'lucide-react'

import { LogDrawer } from '../components/common/LogDrawer'
import { PageLayout } from '../components/common/PageLayout'
import { Panel } from '../components/common/Panel'
import { useVoicePageState } from './voice/useVoicePageState'
import { VoiceRegistryList } from './voice/VoiceRegistryList'
import { VoiceTemplateList } from './voice/VoiceTemplateList'

export function VoicePage() {
  const {
    applyVoice,
    createVoice,
    currentVoiceId,
    file,
    importTemplates,
    logOpen,
    logs,
    message,
    prefix,
    refreshTemplates,
    selectedTemplate,
    setFile,
    setLogOpen,
    setPrefix,
    templates,
    voices,
  } = useVoicePageState()

  return <PageLayout
    className="voice-page"
    bodyClassName="no-scroll"
    title="音色克隆"
    action={<button className="button" onClick={() => setLogOpen(true)}><Terminal className="button-icon" />查看日志</button>}
  >
    <div className="voice-layout">
      <div className="content-grid voice-grid streamlined no-log">
        <div className="voice-left-column">
          <Panel className="voice-template-panel">
            <div className="panel-title spread">
              <span><FileAudio className="title-icon" />声音模板</span>
              <span className="button-row">
                <button className="text-button" onClick={importTemplates}><Plus className="button-icon" />添加音频</button>
                <button className="text-button" onClick={refreshTemplates}><RefreshCw className="button-icon" />刷新</button>
              </span>
            </div>

            <VoiceTemplateList templates={templates} selectedPath={file} onSelect={setFile} />
          </Panel>

          <div className="voice-dock voice-left-dock">
            <div className="voice-create-strip voice-create-stack">
              <div className="voice-selected-template">
                <span>当前样本</span>
                <strong title={selectedTemplate?.path || file}>{selectedTemplate?.name || (file ? file : '未选择')}</strong>
              </div>
              <div className="clean-field compact-field">
                <label>音色前缀</label>
                <input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="只能用英文字母和数字" />
              </div>
              <button className="button primary" onClick={createVoice} disabled={!file}><Mic2 className="button-icon" />创建音色</button>
              {message ? <div className="inline-status voice-create-message">{message}</div> : null}
            </div>
          </div>
        </div>

        <Panel className="voice-registry-panel">
          <div className="panel-title spread">
            <span><Mic2 className="title-icon" />已克隆音色</span>
            <button className="text-button" onClick={refreshTemplates}>刷新</button>
          </div>
          <VoiceRegistryList voices={voices} currentVoiceId={currentVoiceId} onApply={applyVoice} />
        </Panel>
      </div>
    </div>

    <LogDrawer
      open={logOpen}
      title="音色日志"
      subtitle={selectedTemplate?.name || '音色克隆'}
      log={logs.join('') || message || '暂无日志'}
      onClose={() => setLogOpen(false)}
    />
  </PageLayout>
}
