import { useMemo, useState } from 'react'
import { buildVoiceScriptBody, formatVoiceScriptDuration, voiceScriptParagraphs } from './voiceScriptBody'

export function VoiceScriptBodyDialog({ source, allowEmpty = false, onCancel, onConfirm }: {
  source: string
  allowEmpty?: boolean
  onCancel: () => void
  onConfirm: (body: string) => void
}) {
  const initial = useMemo(() => voiceScriptParagraphs(source), [source])
  const [paragraphs, setParagraphs] = useState(initial)
  const body = buildVoiceScriptBody(paragraphs)
  const characters = body.replace(/\s/g, '').length
  const durationText = formatVoiceScriptDuration(characters)
  return <div className="setup-overlay">
    <section className="setup-dialog voice-script-dialog" role="dialog" aria-modal="true" aria-label="确认口播正文">
      <div className="setup-head"><strong>确认口播正文</strong></div>
      <div className="setup-body">
        <p>请选择需要逐字作为口播的原文段落。标题、项目信息和短键值行默认不选。</p>
        <div className="voice-script-paragraphs">{paragraphs.map((paragraph, index) => <label key={index}>
          <input type="checkbox" checked={paragraph.selected} onChange={(event) => setParagraphs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, selected: event.target.checked } : item))} />
          <span>{paragraph.text || '（空行）'}</span>
        </label>)}</div>
      </div>
      <div className="setup-footer voice-script-footer"><span>{characters} 字 · 预计 {durationText}</span><div className="button-row"><button className="button" type="button" onClick={onCancel}>取消</button><button className="button primary" type="button" disabled={!allowEmpty && !body.trim()} onClick={() => onConfirm(body)}>确认并导入</button></div></div>
    </section>
  </div>
}
