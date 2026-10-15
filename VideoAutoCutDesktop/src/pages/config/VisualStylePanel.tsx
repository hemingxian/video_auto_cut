import { LayoutTemplate, Subtitles } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import notoFontLicense from '../../../../VideoAutoCut/fonts/noto-sans-cjk-sc/LICENSE?url'

import { CategoryTabs, type CategoryTabItem } from '../../components/common/CategoryTabs'
import { CloseButton } from '../../components/common/CloseButton'
import { SelectField } from '../../components/common/SelectField'
import { SideDrawer } from '../../components/common/SideDrawer'
import { subtitleFontOptions } from '../../config/subtitleFonts'
import type { ConfigValue } from '../../types/app'
import type { ProgressTemplateSettings } from '../../types/videoauto'
import { colorParts, colorToCss, type ColorParts } from './color'
import {
  ProgressTemplateBar,
  ProgressTemplatePanel,
} from './ProgressTemplatePanel'
import { progressPreviewStyle } from './progressTemplateStyle'
import { useProgressTemplateLibrary } from './useProgressTemplateLibrary'
import { subtitlePreviewLayout, type SubtitlePictureMode } from './subtitlePreviewLayout'

type ConfigValues = Record<string, ConfigValue>
type VisualStyleTab = 'subtitle' | 'progress'

const VISUAL_STYLE_TABS: CategoryTabItem<VisualStyleTab>[] = [
  { id: 'subtitle', label: '字幕' },
  { id: 'progress', label: '进度条' },
]

function configText(values: ConfigValues, key: string, fallback: string) {
  const value = values[key]
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value || '').trim()
  return text || fallback
}

function configNumber(values: ConfigValues, key: string, fallback: number, min: number, max: number) {
  const parsed = Number(configText(values, key, String(fallback)))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function isEnabledValue(value: ConfigValue | undefined, fallback = false) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return fallback
  return text === 'true' || text === '1' || text === 'on'
}

function videoWidthUnit(value: number) {
  return `${(value / 1920) * 100}cqw`
}

function visualPreviewStyle(values: ConfigValues, progressSettings: ProgressTemplateSettings) {
  const font = configText(values, 'SUBTITLE_FONT', 'Microsoft YaHei')
  const fontSize = configNumber(values, 'SUBTITLE_FONT_SIZE', 68, 36, 96)
  const outline = 4
  const shadow = 1
  return {
    ...progressPreviewStyle(progressSettings),
    '--visual-subtitle-font': `"${font}", "Microsoft YaHei", sans-serif`,
    '--visual-subtitle-size': videoWidthUnit(fontSize),
    '--visual-subtitle-primary': colorToCss(configText(values, 'SUBTITLE_PRIMARY_COLOUR', '#FFFFFF'), '#FFFFFF'),
    '--visual-subtitle-outline': colorToCss(configText(values, 'SUBTITLE_OUTLINE_COLOUR', '#121212'), '#121212'),
    '--visual-subtitle-back': colorToCss('&H96000000&', '#000000'),
    '--visual-subtitle-outline-width': videoWidthUnit(outline),
    '--visual-subtitle-shadow': videoWidthUnit(shadow),
    '--visual-subtitle-weight': '700',
  } as CSSProperties
}

function UnifiedPreview({
  enabled,
  settings,
  values,
  showLayoutChoices = false,
}: {
  enabled: boolean
  settings: ProgressTemplateSettings
  values: ConfigValues
  showLayoutChoices?: boolean
}) {
  const [pictureMode, setPictureMode] = useState<SubtitlePictureMode>('full')
  const layout = subtitlePreviewLayout({
    fontSize: configNumber(values, 'SUBTITLE_FONT_SIZE', 68, 36, 96),
    progressHeight: Number(settings.PROGRESS_BAR_HEIGHT) || 38,
    progressEnabled: enabled,
    pictureMode,
  })
  const style = {
    ...visualPreviewStyle(values, settings),
    '--progress-preview-bottom': `${layout.progressBottom / 1080 * 100}%`,
    '--progress-preview-height': `${layout.progressHeight / 1080 * 100}%`,
  } as CSSProperties
  return <div className="visual-preview-example">
    {showLayoutChoices ? <div className="visual-preview-layout-choices" aria-label="预览画面布局">
      <button type="button" className={pictureMode === 'full' ? 'is-active' : ''} onClick={() => setPictureMode('full')}>画面铺满</button>
      <button type="button" className={pictureMode === 'letterbox' ? 'is-active' : ''} onClick={() => setPictureMode('letterbox')}>上下留黑</button>
    </div> : null}
    <div className="visual-preview-frame" style={style}>
    <div className="visual-preview-grid" />
    <div className="visual-preview-safe-area" />
    <div className="visual-preview-media-lines">
      <span />
      <span />
      <span />
    </div>
    {pictureMode === 'letterbox' ? <>
      <div className="visual-preview-letterbox" style={{ top: 0, height: `${layout.pictureTop / 1080 * 100}%` }} />
      <div className="visual-preview-letterbox" style={{ bottom: 0, height: `${layout.progressBottom / 1080 * 100}%` }} />
    </> : null}
    {enabled ? <ProgressTemplateBar className="visual-preview-progress" /> : null}
    <div className="visual-preview-subtitles">
      {['智能剪辑正在生成标准字幕', '字幕随画面和进度条自动定位'].map((line, index) => <span key={line} style={{
        top: `${layout.lineY[index] / 1080 * 100}%`,
        transform: layout.anchor === 'bottom' ? 'translateY(-100%)' : undefined,
      }}>{line}</span>)}
    </div>
    </div>
    {showLayoutChoices ? <p className="visual-preview-caption">{isEnabledValue(values.SUBTITLE_AI_SAFE_AREA)
      ? '此处仅显示默认布局。AI 避让主体的实际位置在生成时根据素材采样确定，请在成片中查看；检测失败会提示并回到默认位置。'
      : '布局示意。成片会按实际素材画面和字幕大小自动定位。'}</p> : null}
  </div>
}

function SubtitleNumberField({
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
  const parsed = Number(value)
  const numeric = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min

  return <label className="visual-style-field">
    <span>{label}</span>
    <div className="visual-number-input">
      <input
        type="range"
        min={min}
        max={max}
        value={numeric}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        className="visual-number-value"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  </label>
}

function SubtitleColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string
  value: string
  fallback: string
  onChange: (value: string) => void
}) {
  const parts = colorParts(value, fallback)

  function update(next: Partial<ColorParts>) {
    const hex = next.hex ?? parts.hex
    onChange(hex.toUpperCase())
  }

  return <div className="visual-style-field">
    <span>{label}</span>
    <div className="color-setting-control">
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
    </div>
  </div>
}

export function VisualStylePanel({
  values,
  onChange,
}: {
  values: ConfigValues
  onChange: (key: string, value: ConfigValue) => void
}) {
  const [activeTab, setActiveTab] = useState<VisualStyleTab>('subtitle')
  const [styleDialogOpen, setStyleDialogOpen] = useState(false)
  const progressEnabled = isEnabledValue(values.PROGRESS_BAR, true)
  const progressLibrary = useProgressTemplateLibrary(values.PROGRESS_TEMPLATE)

  const subtitleSummary = `${configText(values, 'SUBTITLE_FONT', 'Microsoft YaHei')} / ${configText(values, 'SUBTITLE_FONT_SIZE', '68')}px`
  const progressSummary = progressEnabled ? progressLibrary.selected.label : '已关闭'

  return <>
    <div className="visual-style-summary">
      <div className="visual-style-summary-preview">
        <UnifiedPreview enabled={progressEnabled} settings={progressLibrary.selected.settings} values={values} />
      </div>
      <div className="visual-style-summary-copy">
        <strong>当前默认画面样式</strong>
        <div>
          <span>字幕：{subtitleSummary}</span>
          <span>进度条：{progressSummary}</span>
          {isEnabledValue(values.SUBTITLE_AI_SAFE_AREA) ? <span>AI 字幕避让已开启 · 实际位置生成后可见</span> : null}
          {isEnabledValue(values.VIDEOAUTO_TEMPLATE_PACKAGING) ? <span>模板包装已开启</span> : null}
        </div>
      </div>
      <button className="button primary" type="button" onClick={() => setStyleDialogOpen(true)}>
        <LayoutTemplate className="button-icon" />编辑画面样式
      </button>
    </div>

    <SideDrawer
      open={styleDialogOpen}
      className="settings-drawer-overlay"
      panelClassName="settings-drawer visual-style-drawer"
      onClose={() => setStyleDialogOpen(false)}
    >
        <div className="settings-drawer-head visual-style-drawer-head">
          <div>
            <strong>画面样式</strong>
            <span>调整字幕和底部进度条，同时预览默认样式和自动布局</span>
          </div>
          <CloseButton onClick={() => setStyleDialogOpen(false)} iconClassName="icon" />
        </div>
        <div className="settings-drawer-body visual-style-drawer-body">
          <div className="visual-style-panel">
            <div className="visual-style-controls">
              <CategoryTabs
                active={activeTab}
                className="visual-style-tabs"
                items={VISUAL_STYLE_TABS}
                onChange={setActiveTab}
              />

              {activeTab === 'subtitle' ? <section className="visual-style-section">
                <div className="visual-style-section-head">
                  <div>
                    <Subtitles className="button-icon" />
                    <strong>字幕</strong>
                  </div>
                </div>
                <div className="visual-style-fields">
            <label className="visual-style-field is-wide">
              <span>字幕字体</span>
              <SelectField
                value={configText(values, 'SUBTITLE_FONT', 'Microsoft YaHei')}
                options={subtitleFontOptions}
                placeholder="选择字幕字体"
                onChange={(value) => onChange('SUBTITLE_FONT', value)}
              />
              <p className="visual-preview-caption">内置 Noto 黑体支持中英文，可用于商业视频。<a href={notoFontLicense} download="Noto-Sans-CJK-SC-LICENSE.txt">查看字体授权</a></p>
            </label>
            <SubtitleColorField
              label="文字颜色"
              value={configText(values, 'SUBTITLE_PRIMARY_COLOUR', '#FFFFFF')}
              fallback="#FFFFFF"
              onChange={(value) => onChange('SUBTITLE_PRIMARY_COLOUR', value)}
            />
            <SubtitleColorField
              label="描边颜色"
              value={configText(values, 'SUBTITLE_OUTLINE_COLOUR', '#121212')}
              fallback="#121212"
              onChange={(value) => onChange('SUBTITLE_OUTLINE_COLOUR', value)}
            />
            <SubtitleNumberField
              label="字幕大小"
              min={36}
              max={96}
              value={configText(values, 'SUBTITLE_FONT_SIZE', '68')}
              onChange={(value) => onChange('SUBTITLE_FONT_SIZE', value)}
            />
            <div className="visual-style-field is-wide">
              <span>字幕位置：自动</span>
              <p className="visual-preview-caption">画面下方黑边足够时，字幕放在画面下方 5px；否则放在进度条上方 5px。关闭进度条时靠近画面底部。位置随实际素材调整。</p>
            </div>
            <div className="visual-style-field is-wide">
              <div className="visual-style-section-head">
                <span>AI 避让主体（可选）</span>
                <button type="button" role="switch" aria-label="AI 避让主体（可选）" aria-checked={isEnabledValue(values.SUBTITLE_AI_SAFE_AREA)}
                  className={`switch-button${isEnabledValue(values.SUBTITLE_AI_SAFE_AREA) ? ' on' : ''}`}
                  onClick={() => onChange('SUBTITLE_AI_SAFE_AREA', !isEnabledValue(values.SUBTITLE_AI_SAFE_AREA))}>
                  <span /><em>{isEnabledValue(values.SUBTITLE_AI_SAFE_AREA) ? '开启' : '关闭'}</em>
                </button>
              </div>
              <p className="visual-preview-caption">默认关闭。开启后使用已配置的模型服务采样画面，避让主体、人脸和原文字，在画面下半部选择字幕位置。黑边足够时保持默认，不调用模型。采样不能保证每一帧都避开，检测失败会提示并使用默认位置。</p>
            </div>
            <div className="visual-style-field is-wide">
              <div className="visual-style-section-head">
                <span>模板包装（可选）</span>
                <button type="button" role="switch" aria-label="模板包装（可选）" aria-checked={isEnabledValue(values.VIDEOAUTO_TEMPLATE_PACKAGING)}
                  className={`switch-button${isEnabledValue(values.VIDEOAUTO_TEMPLATE_PACKAGING) ? ' on' : ''}`}
                  onClick={() => onChange('VIDEOAUTO_TEMPLATE_PACKAGING', !isEnabledValue(values.VIDEOAUTO_TEMPLATE_PACKAGING))}>
                  <span /><em>{isEnabledValue(values.VIDEOAUTO_TEMPLATE_PACKAGING) ? '开启' : '关闭'}</em>
                </button>
              </div>
              <p className="visual-preview-caption">默认关闭。使用固定标题、参数与行动提示，按脚本写好的上屏文字叠加；实际效果在生成后查看。</p>
            </div>
            {isEnabledValue(values.VIDEOAUTO_TEMPLATE_PACKAGING) ? <div className="visual-style-field is-wide">
              <div className="visual-style-section-head">
                <span>只按脚本上屏（推荐）</span>
                <button type="button" role="switch" aria-label="只按脚本上屏（推荐）" aria-checked={isEnabledValue(values.VIDEOAUTO_PACKAGING_SCRIPT_ONLY, true)}
                  className={`switch-button${isEnabledValue(values.VIDEOAUTO_PACKAGING_SCRIPT_ONLY, true) ? ' on' : ''}`}
                  onClick={() => onChange('VIDEOAUTO_PACKAGING_SCRIPT_ONLY', !isEnabledValue(values.VIDEOAUTO_PACKAGING_SCRIPT_ONLY, true))}>
                  <span /><em>{isEnabledValue(values.VIDEOAUTO_PACKAGING_SCRIPT_ONLY, true) ? '开启' : '关闭'}</em>
                </button>
              </div>
              <p className="visual-preview-caption">默认开启。只有脚本写了上屏内容的分镜才会出现卡片；关闭后未写的分镜会用分镜标题当卡片文字。</p>
            </div> : null}
          </div>
        </section> : null}

        {activeTab === 'progress' ? <ProgressTemplatePanel
          enabled={progressEnabled}
          library={progressLibrary}
          onEnabledChange={(enabled) => onChange('PROGRESS_BAR', enabled)}
          onTemplateChange={(key) => onChange('PROGRESS_TEMPLATE', key)}
        /> : null}
      </div>

      <aside className="visual-style-preview-pane">
        <UnifiedPreview enabled={progressEnabled} settings={progressLibrary.selected.settings} values={values} showLayoutChoices />
      </aside>
    </div>
        </div>
    </SideDrawer>

  </>
}
