import {
  FileVideo2,
  Folder,
  FolderOpen,
  RefreshCw,
  Save,
  X,
} from 'lucide-react'
import { useState } from 'react'

import { referenceShots, type ReferenceShot } from './fixtures'
import type { ReferenceSelection } from './model'
import { summarizeReferenceSelections } from './model'
import { ReferenceBackdrop } from './ReferenceChrome'
import { ShotMaterialPickerReferencePage } from './ShotMaterialPickerReferencePage'

function updateShot(
  shots: ReferenceShot[],
  index: number,
  field: keyof Pick<ReferenceShot, 'title' | 'voiceText' | 'searchQuery' | 'visualQuery' | 'clipRequirements'>,
  value: string,
) {
  return shots.map((shot, shotIndex) => (
    shotIndex === index ? { ...shot, [field]: value } : shot
  ))
}

export function StoryboardEditorReferencePage() {
  const [topic, setTopic] = useState('智能储能，让绿色能源触手可及')
  const [shots, setShots] = useState<ReferenceShot[]>(referenceShots)
  const [pickerShotIndex, setPickerShotIndex] = useState<number | null>(null)
  const [savedAt, setSavedAt] = useState('')

  const updateField = (
    index: number,
    field: keyof Pick<ReferenceShot, 'title' | 'voiceText' | 'searchQuery' | 'visualQuery' | 'clipRequirements'>,
    value: string,
  ) => {
    setSavedAt('')
    setShots((current) => updateShot(current, index, field, value))
  }

  return <div className="vac-ref-page vac-ref-editor-page">
    <ReferenceBackdrop />
    <section className="vac-ref-editor-drawer">
      <header className="vac-ref-editor-header">
        <div>
          <h1>编辑分镜</h1>
          <p>当前任务：draft_20260730_001</p>
        </div>
        <div>
          <button type="button"><RefreshCw />刷新</button>
          <button
            className="primary"
            type="button"
            onClick={() => setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))}
          ><Save />保存</button>
          <button className="icon" type="button" aria-label="关闭"><X /></button>
        </div>
      </header>

      <main className="vac-ref-editor-body">
        <label className="vac-ref-topic">
          <span>主题</span>
          <input value={topic} onChange={(event) => { setTopic(event.target.value); setSavedAt('') }} />
        </label>

        <div className="vac-ref-shot-list">
          {shots.map((shot, index) => {
            const summary = summarizeReferenceSelections(shot.selections)
            return <article className="vac-ref-shot-card" key={shot.id}>
              <div className="vac-ref-shot-index">{String(shot.id).padStart(2, '0')}</div>
              <div className="vac-ref-shot-content">
                <div className="vac-ref-shot-head">
                  <strong>{shot.title}</strong>
                  <span>{shot.timeRange}</span>
                </div>
                <div className="vac-ref-shot-fields">
                  <label className="title-field">
                    <span>分镜标题</span>
                    <input value={shot.title} onChange={(event) => updateField(index, 'title', event.target.value)} />
                  </label>
                  <label>
                    <span>口播文案</span>
                    <textarea value={shot.voiceText} onChange={(event) => updateField(index, 'voiceText', event.target.value)} />
                  </label>
                  <label>
                    <span>素材搜索词</span>
                    <textarea value={shot.searchQuery} onChange={(event) => updateField(index, 'searchQuery', event.target.value)} />
                  </label>
                  <label className="title-field">
                    <span>想要的画面</span>
                    <textarea value={shot.visualQuery} onChange={(event) => updateField(index, 'visualQuery', event.target.value)} />
                  </label>
                  <label>
                    <span>剪辑要求</span>
                    <textarea value={shot.clipRequirements} onChange={(event) => updateField(index, 'clipRequirements', event.target.value)} />
                  </label>
                </div>
                <section className="vac-ref-shot-material">
                  <div>
                    <strong>分镜素材</strong>
                    <span>{shot.selections.length
                      ? `${summary.materialCount} 个视频 · ${summary.folderCount} 个文件夹 · 约 ${summary.candidateCount} 个候选视频`
                      : '未指定素材范围，沿用任务当前素材设置'}</span>
                  </div>
                  <button type="button" onClick={() => setPickerShotIndex(index)}><FolderOpen />选择素材</button>
                  {shot.selections.length ? <div className="vac-ref-shot-selection-chips">
                    {shot.selections.map((selection) => <span key={`${selection.kind}:${selection.id}`}>
                      {selection.kind === 'folder' ? <Folder /> : <FileVideo2 />}
                      <strong>{selection.name}</strong>
                      <button
                        type="button"
                        aria-label={`移除 ${selection.name}`}
                        onClick={() => setShots((current) => current.map((currentShot, currentIndex) => (
                          currentIndex === index
                            ? {
                              ...currentShot,
                              selections: currentShot.selections.filter((item) => (
                                item.kind !== selection.kind || item.id !== selection.id
                              )),
                            }
                            : currentShot
                        )))}
                      ><X /></button>
                    </span>)}
                  </div> : null}
                </section>
              </div>
            </article>
          })}
        </div>
      </main>

      {savedAt ? <div className="vac-ref-editor-saved" role="status">已保存 · {savedAt}</div> : null}
    </section>

    {pickerShotIndex !== null ? <ShotMaterialPickerReferencePage
      embedded
      onClose={() => setPickerShotIndex(null)}
      onConfirm={(selections: ReferenceSelection[]) => {
        setShots((current) => current.map((shot, index) => (
          index === pickerShotIndex ? { ...shot, selections } : shot
        )))
        setPickerShotIndex(null)
        setSavedAt('')
      }}
    /> : null}
  </div>
}
