import { Copy, Edit3, Gauge, LayoutTemplate, Plus, Save, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { cx } from '../../lib/className'
import type { ProgressTemplateRecord, ProgressTemplateSettings } from '../../types/videoauto'
import { colorParts, storedColor, type ColorParts } from './color'
import { DEFAULT_PROGRESS_TEMPLATE_KEY, type ProgressTemplateItem } from './progressTemplateModel'
import {
  completeProgressTemplateSettings,
  progressPreviewStyle,
} from './progressTemplateStyle'
import type { ProgressTemplateLibrary } from './useProgressTemplateLibrary'

const MODULES = ['开场', '概念', '案例', '总结']
const ACTIVE_INDEX = 1

type DraftTemplate = {
  key: string
  label: string
  tone: string
  settings: ProgressTemplateSettings
  editingKey?: string
}

function numberSetting(settings: ProgressTemplateSettings, key: string, fallback: number, min: number, max: number) {
  const parsed = Number(settings[key])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function ProgressTemplateBar({ className }: { className?: string }) {
  return <div className={cx('progress-preview-bar', className)}>
    {MODULES.map((label, index) => <div className="progress-preview-segment" key={label}>
      <div className={cx(
        'progress-preview-fill',
        index < ACTIVE_INDEX && 'is-complete',
        index === ACTIVE_INDEX && 'is-current',
      )} />
      <span className={index <= ACTIVE_INDEX ? 'is-active' : undefined}>{label}</span>
    </div>)}
  </div>
}

function TemplatePreview({ settings }: { settings: ProgressTemplateSettings }) {
  return <div className="progress-template-video" style={progressPreviewStyle(settings)}>
    <ProgressTemplateBar />
  </div>
}

function makeUserTemplateKey() {
  return `user-${Date.now().toString(36)}`
}

function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return <label className="progress-template-field">
    <span>{label}</span>
    {children}
  </label>
}

function TemplateColorField({
  label,
  value,
  fallback,
  translucent = false,
  onChange,
}: {
  label: string
  value: string
  fallback: string
  translucent?: boolean
  onChange: (value: string) => void
}) {
  const parts = colorParts(value, fallback)

  function update(next: Partial<ColorParts>) {
    onChange(storedColor(next.hex ?? parts.hex, translucent ? next.opacity ?? parts.opacity : 1))
  }

  return <div className="progress-template-field">
    <span>{label}</span>
    <div className="template-color-control">
      <input
        className="color-picker"
        type="color"
        value={parts.hex}
        onChange={(event) => update({ hex: event.target.value })}
        aria-label={`${label}颜色`}
      />
      <input
        className="color-hex-input"
        type="text"
        value={parts.hex}
        onChange={(event) => update({ hex: event.target.value })}
      />
      {translucent ? <div className="template-opacity-control">
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(parts.opacity * 100)}
          onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
          aria-label={`${label}透明度`}
        />
        <em>{Math.round(parts.opacity * 100)}%</em>
      </div> : null}
    </div>
  </div>
}

function TemplateNumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: string
  min: number
  max: number
  onChange: (value: string) => void
}) {
  const numeric = numberSetting({ value }, 'value', min, min, max)
  return <div className="progress-template-field">
    <span>{label}</span>
    <div className="template-number-control">
      <input type="range" min={min} max={max} value={numeric} onChange={(event) => onChange(event.target.value)} />
      <input type="number" min={min} max={max} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  </div>
}

function TemplateCard({
  template,
  selected,
  current,
  onSelect,
}: {
  template: ProgressTemplateItem
  selected: boolean
  current: boolean
  onSelect: (template: ProgressTemplateItem) => void
}) {
  return <button
    className={cx('progress-template-card', selected && 'is-selected', current && 'is-current')}
    aria-label={template.label}
    type="button"
    onClick={() => onSelect(template)}
  >
    <TemplatePreview settings={template.settings} />
  </button>
}

function TemplateSection({
  title,
  templates,
  focusedKey,
  currentKey,
  onSelect,
}: {
  title: string
  templates: ProgressTemplateItem[]
  focusedKey: string
  currentKey: string
  onSelect: (template: ProgressTemplateItem) => void
}) {
  if (!templates.length) return null
  return <section className="progress-template-gallery-section">
    <h3>{title}</h3>
    <div className="progress-template-gallery-grid">
      {templates.map((template) => <TemplateCard
        current={currentKey === template.key}
        key={template.key}
        onSelect={onSelect}
        selected={focusedKey === template.key}
        template={template}
      />)}
    </div>
  </section>
}

export function ProgressTemplatePanel({
  enabled,
  library,
  onEnabledChange,
  onTemplateChange,
}: {
  enabled: boolean
  library: ProgressTemplateLibrary
  onEnabledChange: (enabled: boolean) => void
  onTemplateChange: (key: string) => void
}) {
  const [modal, setModal] = useState<'library' | 'editor' | null>(null)
  const [draft, setDraft] = useState<DraftTemplate | null>(null)
  const [focusedKey, setFocusedKey] = useState('')
  const [error, setError] = useState('')
  const focused = library.items.find((template) => template.key === focusedKey) || library.selected

  function openLibrary() {
    setFocusedKey(library.selected.key)
    setError(library.loadError)
    setModal('library')
  }

  function applyTemplate(template: ProgressTemplateRecord) {
    onTemplateChange(template.key)
    setFocusedKey(template.key)
    setModal(null)
  }

  function openEditor(template: ProgressTemplateItem = focused, editing = false) {
    const isUserEdit = editing && template.source === 'user'
    setDraft({
      key: isUserEdit ? template.key : makeUserTemplateKey(),
      editingKey: isUserEdit ? template.key : undefined,
      label: isUserEdit ? template.label : `${template.label} 副本`,
      tone: isUserEdit ? template.tone : template.tone || '自定义模板',
      settings: completeProgressTemplateSettings(template.settings),
    })
    setError('')
    setModal('editor')
  }

  function updateDraftSetting(key: string, value: string) {
    setDraft((current) => current ? {
      ...current,
      settings: { ...current.settings, [key]: value },
    } : current)
  }

  async function saveDraft() {
    if (!draft) return
    const label = draft.label.trim()
    if (!label) {
      setError('请填写模板名称')
      return
    }

    const now = new Date().toISOString()
    const current = library.userTemplates.find((template) => template.key === draft.editingKey)
    const record: ProgressTemplateRecord = {
      key: draft.key,
      label,
      tone: draft.tone.trim() || '自定义模板',
      settings: completeProgressTemplateSettings(draft.settings),
      createdAt: current?.createdAt || now,
      updatedAt: now,
    }
    const next = draft.editingKey
      ? library.userTemplates.map((template) => template.key === draft.editingKey ? record : template)
      : [...library.userTemplates, record]

    try {
      await library.persist(next)
      onTemplateChange(record.key)
      setFocusedKey(record.key)
      setModal('library')
    } catch (saveError) {
      setError(String(saveError instanceof Error ? saveError.message : saveError))
    }
  }

  async function deleteTemplate(template: ProgressTemplateItem) {
    if (template.source !== 'user') return
    if (!window.confirm(`删除模板“${template.label}”？`)) return

    try {
      await library.persist(library.userTemplates.filter((item) => item.key !== template.key))
      if (library.selectedKey === template.key) onTemplateChange(DEFAULT_PROGRESS_TEMPLATE_KEY)
      setFocusedKey(DEFAULT_PROGRESS_TEMPLATE_KEY)
    } catch (deleteError) {
      setError(String(deleteError instanceof Error ? deleteError.message : deleteError))
    }
  }

  const modalLayer = modal ? createPortal(<div
    className="setup-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) setModal(null)
    }}
  >
    <section className="setup-dialog progress-template-dialog" role="dialog" aria-modal="true" aria-label={modal === 'library' ? '进度条模板库' : '创建进度条模板'}>
      <div className="setup-head">
        <div>
          <LayoutTemplate className="title-icon" />
          <span>
            <strong>{modal === 'library' ? '进度条模板库' : draft?.editingKey ? '编辑模板' : '创建模板'}</strong>
            <em>{modal === 'library' ? '选择模板，或添加自己的样式' : '调整后保存到我的模板'}</em>
          </span>
        </div>
        <CloseButton onClick={() => setModal(null)} iconClassName="icon" />
      </div>

      <div className="setup-body">
        {error ? <div className="config-inline-error">{error}</div> : null}
        {modal === 'library' ? <div className="progress-template-library-panel">
          <div className="progress-template-library-toolbar">
            <div>
              <strong>{focused.label}</strong>
              <span>{focused.source === 'built-in' ? '默认模板' : focused.tone}</span>
            </div>
            <button className="button primary" type="button" onClick={() => openEditor()}>
              <Plus className="button-icon" />添加模板
            </button>
          </div>
          <div className="progress-template-gallery">
            <TemplateSection
              currentKey={library.selected.key}
              focusedKey={focused.key}
              onSelect={(template) => setFocusedKey(template.key)}
              templates={library.customTemplates}
              title="我的模板"
            />
            <TemplateSection
              currentKey={library.selected.key}
              focusedKey={focused.key}
              onSelect={(template) => setFocusedKey(template.key)}
              templates={library.builtInTemplates}
              title="默认模板"
            />
          </div>
          <div className="progress-template-library-footer">
            <span>{library.selected.key === focused.key ? '当前正在使用这个模板' : '选中后可应用到生成视频'}</span>
            <div>
              <button className="button primary" type="button" disabled={library.selected.key === focused.key} onClick={() => applyTemplate(focused)}>
                {library.selected.key === focused.key ? '正在使用' : '使用模板'}
              </button>
              {focused.source === 'user'
                ? <>
                  <button className="button" type="button" onClick={() => openEditor(focused, true)}><Edit3 className="button-icon" />编辑</button>
                  <button className="button danger" type="button" onClick={() => deleteTemplate(focused)}><Trash2 className="button-icon" />删除</button>
                </>
                : <button className="button" type="button" onClick={() => openEditor(focused)}><Copy className="button-icon" />复制并编辑</button>}
            </div>
          </div>
        </div> : null}

        {modal === 'editor' && draft ? <div className="progress-template-editor">
          <div className="progress-template-editor-form">
            <FieldLabel label="模板名称">
              <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </FieldLabel>
            <FieldLabel label="模板备注">
              <input value={draft.tone} onChange={(event) => setDraft({ ...draft, tone: event.target.value })} />
            </FieldLabel>
            <TemplateColorField label="高亮颜色" value={draft.settings.PROGRESS_HIGHLIGHT_COLOR} fallback="#FFFFFF" translucent onChange={(value) => updateDraftSetting('PROGRESS_HIGHLIGHT_COLOR', value)} />
            <TemplateColorField label="未开始背景" value={draft.settings.PROGRESS_DARK_COLOR} fallback="#323232" translucent onChange={(value) => updateDraftSetting('PROGRESS_DARK_COLOR', value)} />
            <TemplateColorField label="分隔线" value={draft.settings.PROGRESS_SEPARATOR_COLOR} fallback="#171717" translucent onChange={(value) => updateDraftSetting('PROGRESS_SEPARATOR_COLOR', value)} />
            <TemplateColorField label="普通文字" value={draft.settings.PROGRESS_TEXT_COLOR} fallback="#B8B8B8" onChange={(value) => updateDraftSetting('PROGRESS_TEXT_COLOR', value)} />
            <TemplateColorField label="高亮文字" value={draft.settings.PROGRESS_ACTIVE_TEXT_COLOR} fallback="#FFFFFF" onChange={(value) => updateDraftSetting('PROGRESS_ACTIVE_TEXT_COLOR', value)} />
            <TemplateNumberField label="进度条高度" min={24} max={150} value={draft.settings.PROGRESS_BAR_HEIGHT} onChange={(value) => updateDraftSetting('PROGRESS_BAR_HEIGHT', value)} />
            <TemplateNumberField label="底部距离" min={0} max={220} value={draft.settings.PROGRESS_BOTTOM_MARGIN} onChange={(value) => updateDraftSetting('PROGRESS_BOTTOM_MARGIN', value)} />
            <TemplateNumberField label="文字大小" min={16} max={52} value={draft.settings.PROGRESS_FONT_SIZE} onChange={(value) => updateDraftSetting('PROGRESS_FONT_SIZE', value)} />
          </div>
          <div className="progress-template-editor-preview">
            <TemplatePreview settings={draft.settings} />
            <div className="progress-template-editor-actions">
              <button className="button" type="button" onClick={openLibrary}>取消</button>
              <button className="button primary" type="button" onClick={saveDraft}><Save className="button-icon" />保存模板</button>
            </div>
          </div>
        </div> : null}
      </div>
    </section>
  </div>, document.body) : null

  return <>
    <section className="visual-style-section">
      <div className="visual-style-section-head">
        <div>
          <Gauge className="button-icon" />
          <strong>底部进度条</strong>
        </div>
        <button
          type="button"
          className={cx('switch-button', enabled && 'on')}
          aria-pressed={enabled}
          onClick={() => onEnabledChange(!enabled)}
        >
          <span />
          <em>{enabled ? '开启' : '关闭'}</em>
        </button>
      </div>
      <div className="progress-template-showcase">
        <div className="progress-template-showcase-head">
          <div className="progress-template-showcase-title">
            <div>
              <strong>{library.selected.label}</strong>
              <span>默认模板位于最后，可继续添加自定义模板</span>
            </div>
          </div>
          <div className="progress-template-showcase-actions">
            <button className="button" type="button" onClick={openLibrary}>
              <LayoutTemplate className="button-icon" />模板库
            </button>
          </div>
        </div>
        <div className="progress-template-featured-grid">
          {library.featured.map((template) => <TemplateCard
            current={library.selected.key === template.key}
            key={template.key}
            onSelect={applyTemplate}
            selected={library.selected.key === template.key}
            template={template}
          />)}
        </div>
      </div>
    </section>
    {modalLayer}
  </>
}
