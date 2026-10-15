import { useId } from 'react'
import { ArrowRightLeft, Check, ChevronDown, Download, Library } from 'lucide-react'
import * as Select from 'radix-ui/select'

import { materialSourceModeOptions, normalizeMaterialSourceMode, type MaterialSourceMode } from './materialSourceMode'

const modePresentation = {
  'library-only': { icon: Library, hint: '只用素材库，缺少素材时提示补充。' },
  'library-first': { icon: ArrowRightLeft, hint: '先匹配素材库，未命中再下载。' },
  'pexels-only': { icon: Download, hint: '直接下载，不使用绑定的素材范围。' },
}

type MaterialSourceModeSelectProps = {
  value: MaterialSourceMode
  disabled?: boolean
  onChange: (value: MaterialSourceMode) => void
}

export function MaterialSourceModeSelect({ value, disabled, onChange }: MaterialSourceModeSelectProps) {
  const descriptionId = useId()
  const selected = materialSourceModeOptions.find((option) => option.value === value)!
  const Icon = modePresentation[value].icon

  return <Select.Root value={value} disabled={disabled} onValueChange={(next) => onChange(normalizeMaterialSourceMode(next))}>
    <Select.Trigger
      className="material-source-mode-trigger"
      aria-label="素材来源模式"
      aria-describedby={descriptionId}
      title={disabled ? '任务执行或素材准备期间无法切换模式' : selected.description}
    >
      <Icon className="material-source-mode-icon" aria-hidden="true" />
      <span className="material-source-mode-caption" aria-hidden="true">素材来源</span>
      <Select.Value>{selected.label}</Select.Value>
      <Select.Icon className="material-source-mode-chevron"><ChevronDown aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <span id={descriptionId} className="material-source-mode-sr-only">{selected.description}</span>
    <Select.Portal>
      <Select.Content
        className="material-source-mode-menu"
        position="popper"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label="素材来源模式"
      >
        <Select.Viewport>
          <Select.Group>
            <Select.Label className="material-source-mode-heading">选择素材来源</Select.Label>
            {materialSourceModeOptions.map((option) => {
              const presentation = modePresentation[option.value]
              const OptionIcon = presentation.icon
              const hintId = `${descriptionId}-${option.value}`
              return <Select.Item
                key={option.value}
                value={option.value}
                textValue={option.label}
                aria-describedby={hintId}
                className="material-source-mode-option"
              >
                <span className="material-source-mode-option-icon"><OptionIcon aria-hidden="true" /></span>
                <span className="material-source-mode-option-copy">
                  <Select.ItemText><span className="material-source-mode-option-title">{option.label}</span></Select.ItemText>
                  <span id={hintId} className="material-source-mode-option-hint">{presentation.hint}</span>
                </span>
                <span className="material-source-mode-check">
                  <Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator>
                </span>
              </Select.Item>
            })}
          </Select.Group>
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
}
