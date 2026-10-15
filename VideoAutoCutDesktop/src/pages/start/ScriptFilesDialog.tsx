import { FileJson, FileText, FolderOpen, Link2, Play, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CloseButton } from '../../components/common/CloseButton'
import { cx } from '../../lib/className'
import { basename } from '../../lib/path'
import { ShotMaterialPickerDialog } from './ShotMaterialPickerDialog'
import { createShotMaterialPickerCache } from './shotMaterialPickerModel'
import { summarizeShotMaterialSelections, type ShotMaterialSelection } from './shotMaterialSelectionModel'
import { scriptMaterialKey, type ScriptMaterialSelections } from './scriptMaterialScope'
import { outputResolutions, outputSizeLabel } from './outputFormatModel'
import { VoiceScriptBodyDialog } from './VoiceScriptBodyDialog'
import { supportsVoiceScript, voiceScriptImportDecision, VOICE_SCRIPT_DISABLED_HINT } from './voiceScriptBody'

type ScriptFilesDialogProps = {
  open: boolean
  scripts: string
  aspectRatio: string
  outputResolution: string
  onAspectRatioChange: (value: string) => void
  onOutputResolutionChange: (value: string) => void
  materialSelections: ScriptMaterialSelections
  allowMaterialBindings?: boolean
  onMaterialsChange: (scriptPath: string, selections: ShotMaterialSelection[]) => void
  onClose: () => void
  onChooseScripts: () => void
  onScriptsChange: (value: string) => void
  onImportAndPlan: (preparedBodyPaths?: Record<string, string>) => void
  onImportAndGenerate: (preparedBodyPaths?: Record<string, string>) => void
  voiceScriptModes: Record<string, boolean>
  voiceScriptBodyPaths: Record<string, string>
  voiceScriptTaskIds: Record<string, string>
  onVoiceScriptChange: (scriptPath: string, enabled: boolean, bodyPath?: string) => void
}

export function ScriptFilesDialog({
  open,
  scripts,
  aspectRatio,
  outputResolution,
  onAspectRatioChange,
  onOutputResolutionChange,
  materialSelections,
  allowMaterialBindings = true,
  onMaterialsChange,
  onClose,
  onChooseScripts,
  onScriptsChange,
  onImportAndPlan,
  onImportAndGenerate,
  voiceScriptModes,
  voiceScriptBodyPaths,
  voiceScriptTaskIds,
  onVoiceScriptChange,
}: ScriptFilesDialogProps) {
  // AuthenticatedApp is keyed by account, so snapshots survive picker remounts
  // for this account only and are discarded on logout/account change.
  const [materialPickerCache] = useState(createShotMaterialPickerCache)
  const [bindingScriptPath, setBindingScriptPath] = useState<string | null>(null)
  const [bindingAll, setBindingAll] = useState(false)
  const [voicePreview, setVoicePreview] = useState<{ path: string; source: string } | null>(null)
  const [pendingImport, setPendingImport] = useState<{ remaining: string[]; prepared: Record<string, string>; generate: boolean } | null>(null)
  const [voiceError, setVoiceError] = useState('')
  useEffect(() => {
    if (!open || !allowMaterialBindings) {
      setBindingScriptPath(null)
      setBindingAll(false)
    }
  }, [open, allowMaterialBindings])
  if (!open) return null

  const scriptPaths = scripts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  const scriptCountLabel = scriptPaths.length ? `${scriptPaths.length} 个脚本` : '未选择脚本'

  function removeScriptPath(path: string) {
    onScriptsChange(scriptPaths.filter((item) => item !== path).join('\n'))
  }

  async function openVoicePreview(path: string) {
    setVoiceError('')
    try {
      setVoicePreview({ path, source: await window.videoAutoCut.readVoiceScriptSource(path) })
    } catch (error) {
      setPendingImport(null)
      setVoiceError(error instanceof Error ? error.message : String(error))
    }
  }

  function beginImport(generate: boolean) {
    const decision = voiceScriptImportDecision(scriptPaths, voiceScriptModes, voiceScriptBodyPaths, scriptMaterialKey)
    if (decision.action === 'enqueue') {
      ;(generate ? onImportAndGenerate : onImportAndPlan)()
      return
    }
    setPendingImport({ remaining: decision.pending, prepared: {}, generate })
    void openVoicePreview(decision.pending[0])
  }

  return <><div
    className="setup-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
  >
    <section className="setup-dialog script-files-dialog" role="dialog" aria-modal="true" aria-label="脚本文件">
      <div className="setup-head">
        <div>
          <FileText className="title-icon" />
          <span>
            <strong>脚本文件</strong>
            <em>{scriptCountLabel}</em>
          </span>
        </div>
        <CloseButton onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body">
        <div className="setup-section-head script-output-format">
          <label htmlFor="script-aspect-ratio">成片比例</label>
          <select id="script-aspect-ratio" className="button" value={aspectRatio} onChange={(event) => onAspectRatioChange(event.target.value)}>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
            <option value="9:16">9:16</option>
            <option value="16:9">16:9</option>
          </select>
          <label htmlFor="script-output-resolution">分辨率</label>
          <select id="script-output-resolution" className="button" value={outputResolution} onChange={(event) => onOutputResolutionChange(event.target.value)}>
            {outputResolutions(aspectRatio).map((resolution) => <option key={resolution} value={resolution}>{resolution === '4k' ? '4K' : resolution} · {outputSizeLabel(aspectRatio, resolution)}</option>)}
          </select>
        </div>
        <section className="setup-section">
          <div className="setup-section-head">
            <label>待处理脚本</label>
            <div className="button-row">
              <button className="button" type="button" disabled={!scriptPaths.length || !allowMaterialBindings} title={allowMaterialBindings ? undefined : '仅 Pexels 模式不使用绑定素材范围'} onClick={() => {
                setBindingScriptPath(null)
                setBindingAll(true)
              }}>
                <Link2 className="button-icon" />统一设置素材范围
              </button>
              {scriptPaths.length ? <button className="text-button muted-action" type="button" onClick={() => onScriptsChange('')}>
                <Trash2 className="button-icon" />清空
              </button> : null}
              {scriptPaths.length ? <button className="button" type="button" onClick={onChooseScripts}>
                <FolderOpen className="button-icon" />添加脚本
              </button> : null}
            </div>
          </div>

          <div className={cx('script-picker-surface', !scriptPaths.length && 'is-empty')}>
            {scriptPaths.length ? <div className="script-file-list">
              {scriptPaths.map((item, index) => {
                const selections = materialSelections[scriptMaterialKey(item)] || []
                const scriptKey = scriptMaterialKey(item)
                const voiceEnabled = voiceScriptModes[scriptKey] === true
                const voiceReady = Boolean(voiceScriptBodyPaths[scriptKey])
                const voiceSupported = supportsVoiceScript(item)
                const summary = summarizeShotMaterialSelections(selections)
                const bound = selections.length > 0
                const bindingHint = !allowMaterialBindings ? '仅 Pexels 模式不使用绑定素材范围' : bound
                  ? `已绑定：${summary.fileCount} 个视频、${summary.folderCount} 个文件夹${summary.candidateCount === null ? '' : `，共 ${summary.candidateCount} 个候选视频`}\n${selections.map((selection) => selection.name).join('、')}\n点击修改或解除绑定`
                  : '绑定素材范围；未绑定时按工作台的素材来源模式获取素材'
                return <article className="script-file-row" key={item}>
                  <span className="script-file-index">{index + 1}</span>
                  <FileText className="script-file-icon" />
                  <div className="script-file-main">
                    <strong title={item}>{basename(item)}</strong>
                    <span title={item}>{item}</span>
                    {bound ? <span className={!allowMaterialBindings ? 'material-binding-inactive' : undefined} title={selections.map((selection) => selection.name).join('、')}>
                      素材范围：{summary.fileCount} 个视频、{summary.folderCount} 个文件夹
                      {summary.candidateCount === null ? '' : ` · ${summary.candidateCount} 个候选视频`}
                      {!allowMaterialBindings ? '（当前模式不生效）' : ''}
                    </span> : null}
                    <label title={voiceSupported ? undefined : VOICE_SCRIPT_DISABLED_HINT}>
                      <input type="checkbox" disabled={!voiceSupported} checked={voiceEnabled} onChange={(event) => {
                        if (!event.target.checked) { onVoiceScriptChange(item, false); return }
                        onVoiceScriptChange(item, true)
                      }} />这份脚本就是口播稿（原文逐字当口播）{voiceEnabled && voiceReady ? ' · 已确认正文' : ''}
                    </label>
                  </div>
                  <button
                    className={cx('icon-button script-file-bind', bound && 'is-bound')}
                    type="button"
                    title={bindingHint}
                    aria-label={`绑定素材：${basename(item)}`}
                    aria-pressed={bound}
                    disabled={!allowMaterialBindings}
                    onClick={() => setBindingScriptPath(item)}
                  ><Link2 className="icon" /></button>
                  <button className="icon-button script-file-remove" type="button" onClick={() => removeScriptPath(item)} aria-label="移除脚本">
                    <Trash2 className="icon" />
                  </button>
                </article>
              })}
            </div> : <div className="script-empty-state">
              <span>还没有选择脚本文件</span>
              <button className="button" type="button" onClick={onChooseScripts}>
                <FolderOpen className="button-icon" />选择脚本
              </button>
            </div>}
          </div>
          {voiceError ? <div className="shot-picker-message">{voiceError}</div> : null}
        </section>
      </div>

      <div className="setup-footer button-row">
        <button className="button primary" type="button" disabled={!scriptPaths.length} onClick={() => beginImport(false)}>
          <FileJson className="button-icon" />导入并整理分镜
        </button>
        <button className="button" type="button" disabled={!scriptPaths.length} onClick={() => beginImport(true)}>
          <Play className="button-icon" />导入并生成视频
        </button>
      </div>
    </section>
  </div>
    {allowMaterialBindings && bindingAll && scriptPaths.length > 0 ? <ShotMaterialPickerDialog
      key="all-scripts"
      directoryCache={materialPickerCache}
      open
      allowEmptySelection
      dialogTitle="统一设置素材范围"
      shotTitle={`应用到当前全部 ${scriptPaths.length} 个脚本，覆盖各自原有范围；不选素材则解除全部绑定。后续新增脚本需重新设置。`}
      initialSelections={materialSelections[scriptMaterialKey(scriptPaths[0])] || []}
      onClose={() => setBindingAll(false)}
      onConfirm={(selections) => {
        for (const scriptPath of scriptPaths) onMaterialsChange(scriptPath, selections)
        setBindingAll(false)
      }}
    /> : null}
    {allowMaterialBindings && bindingScriptPath && scriptPaths.includes(bindingScriptPath) ? <ShotMaterialPickerDialog
      key={bindingScriptPath}
      directoryCache={materialPickerCache}
      open
      allowEmptySelection
      dialogTitle="绑定脚本素材"
      shotTitle={`${basename(bindingScriptPath)} · 仅在绑定范围内选取画面，应用到该脚本的分镜`}
      initialSelections={materialSelections[scriptMaterialKey(bindingScriptPath)] || []}
      onClose={() => setBindingScriptPath(null)}
      onConfirm={(selections) => {
        onMaterialsChange(bindingScriptPath, selections)
        setBindingScriptPath(null)
      }}
    /> : null}
    {voicePreview ? <VoiceScriptBodyDialog key={voicePreview.path} source={voicePreview.source} allowEmpty={/模板版本\s*[：:]\s*VAC-SB-1/.test(voicePreview.source)} onCancel={() => {
      setPendingImport(null)
      setVoicePreview(null)
    }} onConfirm={async (body) => {
      try {
        const key = scriptMaterialKey(voicePreview.path)
        const taskId = voiceScriptTaskIds[key]
        if (!taskId) throw new Error('口播稿任务标识不存在，请重新选择脚本')
        const bodyPath = await window.videoAutoCut.writeVoiceScriptBody(voicePreview.path, body, taskId)
        onVoiceScriptChange(voicePreview.path, true, bodyPath)
        const current = pendingImport
        const prepared = { ...(current?.prepared || {}), [key]: bodyPath }
        const remaining = (current?.remaining || []).slice(1)
        if (remaining.length) {
          setPendingImport({ remaining, prepared, generate: current!.generate })
          await openVoicePreview(remaining[0])
        } else {
          setVoicePreview(null)
          setPendingImport(null)
          ;(current?.generate ? onImportAndGenerate : onImportAndPlan)(prepared)
        }
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : String(error))
      }
    }} /> : null}
  </>
}
