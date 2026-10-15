import { FolderOpen } from 'lucide-react'
import { SelectField } from '../../components/common/SelectField'
import { cx } from '../../lib/className'
import type { ConfigSpec, ConfigValue } from '../../types/app'
import { getPickerColor, hexColorPattern } from './color'

export function SettingRow({
  spec,
  value,
  onChange,
}: {
  spec: ConfigSpec
  value: ConfigValue
  onChange: (value: ConfigValue) => void
}) {
  const textValue = typeof value === 'string' ? value : ''
  const enabled = value === true
  const fallbackColor = spec.placeholder && hexColorPattern.test(spec.placeholder) ? spec.placeholder : '#FFFFFF'

  async function chooseDirectory() {
    const folder = await window.videoAutoCut.chooseFolder({ title: spec.label, defaultPath: textValue || spec.defaultPath || undefined })
    if (folder) onChange(folder)
  }

  return <div className="setting-row">
    <div className="setting-copy">
      <strong>{spec.label}</strong>
      <span>{spec.description}</span>
    </div>
    <div className="setting-control">
      {spec.type === 'switch' ? <button
        type="button"
        className={cx('switch-button', enabled && 'on')}
        aria-pressed={enabled}
        title={enabled ? '已开启' : '已关闭'}
        onClick={() => onChange(!enabled)}
      >
        <span />
        <em>{enabled ? '开启' : '关闭'}</em>
      </button> : null}
      {spec.type === 'select' ? <SelectField value={textValue} onChange={onChange} options={spec.options || []} /> : null}
      {spec.type === 'color' ? <div className="color-setting-control">
        <input
          className="color-picker"
          type="color"
          value={getPickerColor(textValue, fallbackColor)}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          aria-label={`${spec.label}颜色选择器`}
        />
        <input
          className="color-hex-input"
          type="text"
          value={textValue}
          placeholder={spec.placeholder || '#FFFFFF'}
          onChange={(event) => onChange(event.target.value)}
        />
      </div> : null}
      {spec.type === 'directory' ? <div className="directory-input">
        <input
          type="text"
          value={textValue}
          placeholder={spec.placeholder || ''}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="icon-button" title="选择文件夹" onClick={chooseDirectory}>
          <FolderOpen className="button-icon" />
        </button>
      </div> : null}
      {spec.type !== 'switch' && spec.type !== 'select' && spec.type !== 'color' && spec.type !== 'directory' ? <div className="suffix-input">
        <input
          type={spec.type === 'password' ? 'password' : spec.type === 'number' ? 'number' : 'text'}
          value={textValue}
          placeholder={spec.placeholder || ''}
          onChange={(event) => onChange(event.target.value)}
        />
        {spec.suffix ? <span>{spec.suffix}</span> : null}
      </div> : null}
    </div>
  </div>
}
