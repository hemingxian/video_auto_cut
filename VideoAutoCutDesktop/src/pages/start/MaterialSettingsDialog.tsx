import { Boxes } from 'lucide-react'

import { CloseButton } from '../../components/common/CloseButton'
import { SelectField } from '../../components/common/SelectField'

const sourceOptions = [
  { label: 'Pexels（商用）', value: 'pexels' },
]

type MaterialSettingsDialogProps = {
  open: boolean
  source: string
  onClose: () => void
  onSourceChange: (value: string) => void
}

export function MaterialSettingsDialog({
  open,
  onClose,
  onSourceChange,
}: MaterialSettingsDialogProps) {
  if (!open) return null

  return <div
    className="setup-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}
  >
    <section className="setup-dialog material-settings-dialog" role="dialog" aria-modal="true" aria-label="素材设置">
      <div className="setup-head">
        <div>
          <Boxes className="title-icon" />
          <span>
            <strong>素材设置</strong>
            <em>下载来源</em>
          </span>
        </div>
        <CloseButton onClick={onClose} iconClassName="icon" />
      </div>

      <div className="setup-body">
        <div className="setup-grid">
          <div className="clean-field">
            <label>素材来源</label>
            <SelectField value="pexels" onChange={onSourceChange} options={sourceOptions} />
            <p className="field-hint compact">
              素材库包含本地和当前账号云端素材。可在工作台选择仅素材库、素材库未命中后使用 Pexels，或仅 Pexels。已绑定范围优先使用；仅 Pexels 模式不使用绑定范围。
            </p>
          </div>
        </div>
      </div>

      <div className="setup-footer">
        <button className="button" type="button" onClick={onClose}>完成</button>
      </div>
    </section>
  </div>
}
