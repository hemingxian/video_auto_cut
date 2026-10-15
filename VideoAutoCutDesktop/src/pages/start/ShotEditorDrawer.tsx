import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, FileVideo2, FolderClosed, RefreshCw, Save, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CloseButton } from '../../components/common/CloseButton'
import { EmptyState } from '../../components/common/EmptyState'
import { FileActionButton } from '../../components/common/FileActionButton'
import type { MaterialDirectoryListing, RunItem } from '../../types/videoauto'
import type { ScriptImportIssue } from '../../types/videoauto/task'
import type { MaterialUiMetadataMap } from '../materials/materialLibraryUiModel'
import { editableFields } from './constants'
import {
  ShotMaterialPickerDialog,
  type ShotMaterialSelection,
} from './ShotMaterialPickerDialog'
import {
  currentScriptFieldValue,
  isScriptFieldModified,
  nonEmptyLines,
  pendingReviewCount,
  pendingReviewTotal,
  derivedReviewStatus,
  readFieldOrigin,
  readScriptMeta,
  readShotScriptReview,
  readScriptSource,
  shotText,
  warningReviewId,
} from './shotPlan'
import {
  materialBindingsToSelections,
  summarizeShotMaterialSelections,
} from './shotMaterialSelectionModel'
import type {
  EditableShotField,
  RestorableScriptField,
  ShotDraft,
  ShotPlanRoot,
  ShotScriptMetaField,
} from './types'
import { createShotMaterialPickerCache } from './shotMaterialPickerModel'

const emptySelections: ShotMaterialSelection[] = []

type ShotEditorDrawerProps = {
  open: boolean
  topic: string
  shots: ShotDraft[]
  planRoot?: ShotPlanRoot
  allowMaterialBindings?: boolean
  dirty: boolean
  draftSaveStatus: 'idle' | 'saving' | 'saved' | 'failed'
  draftSavedAt: string
  currentRun: RunItem | null
  message: string
  initialMaterialSelections?: Record<number, ShotMaterialSelection[]>
  initialSelectedIndex?: number
  materialListing?: MaterialDirectoryListing
  materialMetadata?: MaterialUiMetadataMap
  pickerInitiallyOpen?: boolean
  onClose: () => void
  onSave: () => Promise<boolean>
  onRefresh: () => Promise<void>
  onTopicChange: (value: string) => void
  onShotChange: (index: number, field: EditableShotField, value: string) => void
  onShotMetaChange?: (index: number, field: ShotScriptMetaField, value: string) => void
  onConfirmReview?: (index: number, fields: string[] | 'all') => void
  onAcknowledgeWarning?: (index: number, id: string) => void
  onRestoreField?: (index: number, field: RestorableScriptField) => void
  onShotMaterialsChange: (
    index: number,
    selections: ShotMaterialSelection[],
    downloadMaterial: boolean,
  ) => void
}

export function ShotEditorDrawer({
  open,
  topic,
  shots,
  planRoot = {},
  allowMaterialBindings = true,
  dirty,
  draftSaveStatus,
  draftSavedAt,
  currentRun,
  message,
  initialMaterialSelections = {},
  initialSelectedIndex = 0,
  materialListing,
  materialMetadata,
  pickerInitiallyOpen = false,
  onClose,
  onSave,
  onRefresh,
  onTopicChange,
  onShotChange,
  onShotMetaChange = () => undefined,
  onConfirmReview = () => undefined,
  onAcknowledgeWarning = () => undefined,
  onRestoreField = () => undefined,
  onShotMaterialsChange,
}: ShotEditorDrawerProps) {
  const [materialPickerCache] = useState(createShotMaterialPickerCache)
  const [selectionsByShot, setSelectionsByShot] = useState<Record<string, ShotMaterialSelection[]>>(
    () => Object.fromEntries(shots.flatMap((shot, index) => {
      const selections = initialMaterialSelections[index]
        || selectionsFromBindings(shot)
      return selections.length ? [[shot.shot_id, selections]] : []
    })),
  )
  const [pickerShotIndex, setPickerShotIndex] = useState<number | null>(
    pickerInitiallyOpen ? initialSelectedIndex : null,
  )
  useEffect(() => {
    if (!allowMaterialBindings) setPickerShotIndex(null)
  }, [allowMaterialBindings])
  const activePickerIndex = allowMaterialBindings && pickerShotIndex !== null && shots[pickerShotIndex]
    ? pickerShotIndex
    : null
  const selectionsForShot = (shot: ShotDraft) => {
    const bindingSelections = selectionsFromBindings(shot)
    return shot.material_resolution?.strategy === 'library'
      ? bindingSelections
      : selectionsByShot[shot.shot_id] || bindingSelections
  }
  const pickerSelections = activePickerIndex === null
    ? emptySelections
    : selectionsForShot(shots[activePickerIndex])

  return <AnimatePresence>
    {open ? <motion.div
      className="shot-drawer-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <motion.aside
        className="shot-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="编辑分镜"
        initial={{ x: 34, opacity: 0.72 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 36, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className="shot-drawer-head">
          <div className="shot-drawer-title">
            <strong>编辑分镜</strong>
            <span>{currentRun?.id ? `当前任务：${currentRun.projectName || currentRun.id}` : '先预览分镜后再编辑'}</span>
          </div>
          <div className="shot-drawer-actions">
            {draftSaveStatus !== 'idle' || dirty ? <span className="shots-dirty-badge">
              {draftSaveStatus === 'saving'
                ? '保存中'
                : draftSaveStatus === 'failed'
                  ? '保存失败'
                  : draftSaveStatus === 'saved'
                    ? `已保存${draftSavedAt ? ` ${draftSavedAt}` : ''}`
                    : '未保存'}
            </span> : null}
            <button className="button" onClick={onRefresh}><RefreshCw className="button-icon" />刷新</button>
            {currentRun?.path ? <FileActionButton className="button" file={currentRun.path} kind="folder" label="目录" /> : null}
            <button className="button primary" onClick={() => onSave()} disabled={!shots.length}><Save className="button-icon" />保存</button>
            <CloseButton onClick={onClose} iconClassName="icon" />
          </div>
        </div>
        <div className="shot-drawer-body">
          {shots.length ? <div className="shots-topic-editor shot-drawer-topic">
            <label>主题</label>
            <input value={topic} onChange={(event) => onTopicChange(event.target.value)} placeholder="视频主题" />
          </div> : null}
          <ShotEditorList
            shots={shots}
            planRoot={planRoot}
            allowMaterialBindings={allowMaterialBindings}
            message={message}
            selectionsByShot={selectionsByShot}
            onChange={onShotChange}
            onMetaChange={onShotMetaChange}
            onConfirmReview={onConfirmReview}
            onAcknowledgeWarning={onAcknowledgeWarning}
            onRestoreField={onRestoreField}
            onOpenPicker={setPickerShotIndex}
            onRemoveSelection={(shotIndex, selection) => {
              if (!allowMaterialBindings) return
              const shot = shots[shotIndex]
              if (!shot) return
              setSelectionsByShot((current) => {
                const bindingSelections = selectionsFromBindings(shot)
                const currentSelections = shot.material_resolution?.strategy === 'library'
                  ? bindingSelections
                  : current[shot.shot_id] || bindingSelections
                const nextSelections = currentSelections.filter(
                  (item) => item.kind !== selection.kind || item.id !== selection.id,
                )
                onShotMaterialsChange(shotIndex, nextSelections, false)
                return { ...current, [shot.shot_id]: nextSelections }
              })
            }}
            onMaterialModeChange={(shotIndex, downloadMaterial) => {
              if (!allowMaterialBindings) return
              const shot = shots[shotIndex]
              if (!shot) return
              const currentSelections = selectionsForShot(shot)
              if (
                downloadMaterial
                && currentSelections.length
                && !window.confirm('切换为自动获取会清空当前分镜已选择的素材，是否继续？')
              ) {
                return
              }
              const nextSelections = downloadMaterial
                ? emptySelections
                : currentSelections
              setSelectionsByShot((current) => ({
                ...current,
                [shot.shot_id]: nextSelections,
              }))
              onShotMaterialsChange(shotIndex, nextSelections, downloadMaterial)
            }}
          />
        </div>
      </motion.aside>
      <ShotMaterialPickerDialog
        directoryCache={materialPickerCache}
        key={activePickerIndex === null ? 'closed' : shots[activePickerIndex].shot_id}
        fixtureListing={materialListing}
        initialSelections={pickerSelections}
        metadataOverrides={materialMetadata}
        open={activePickerIndex !== null}
        shotTitle={activePickerIndex === null
          ? ''
          : `分镜 ${String(activePickerIndex + 1).padStart(2, '0')} · ${shotText(shots[activePickerIndex]?.title) || '未命名分镜'}`}
        onClose={() => setPickerShotIndex(null)}
        onConfirm={(selections) => {
          if (!allowMaterialBindings || activePickerIndex === null) return
          const shot = shots[activePickerIndex]
          if (!shot) return
          setSelectionsByShot((current) => ({ ...current, [shot.shot_id]: selections }))
          onShotMaterialsChange(activePickerIndex, selections, false)
          setPickerShotIndex(null)
        }}
      />
    </motion.div> : null}
  </AnimatePresence>
}

function ShotEditorList({
  shots,
  planRoot,
  allowMaterialBindings,
  message,
  selectionsByShot,
  onChange,
  onMetaChange,
  onConfirmReview,
  onAcknowledgeWarning,
  onRestoreField,
  onOpenPicker,
  onRemoveSelection,
  onMaterialModeChange,
}: {
  shots: ShotDraft[]
  planRoot: ShotPlanRoot
  allowMaterialBindings: boolean
  message: string
  selectionsByShot: Record<string, ShotMaterialSelection[]>
  onChange: (index: number, field: EditableShotField, value: string) => void
  onMetaChange: (index: number, field: ShotScriptMetaField, value: string) => void
  onConfirmReview: (index: number, fields: string[] | 'all') => void
  onAcknowledgeWarning: (index: number, id: string) => void
  onRestoreField: (index: number, field: RestorableScriptField) => void
  onOpenPicker: (index: number) => void
  onRemoveSelection: (index: number, selection: ShotMaterialSelection) => void
  onMaterialModeChange: (index: number, downloadMaterial: boolean) => void
}) {
  const [pendingOnly, setPendingOnly] = useState(false)
  if (!shots.length) return <EmptyState title="暂无分镜" description={message} />

  const scriptSource = readScriptSource(planRoot)
  const standardCarrier = scriptSource?.route === 'template'
    ? (scriptSource.carrier === 'markdown' ? 'Markdown' : 'Excel') : ''
  const visibleShots = scriptSource && pendingOnly
    ? shots.map((shot, index) => ({ shot, index })).filter(({ shot }) => pendingReviewCount(shot) > 0)
    : shots.map((shot, index) => ({ shot, index }))

  return <div className="shot-preview-list shot-editor-list">
    {scriptSource ? <div className="template-workspace-banner">
      <span><strong>{scriptSource.route === 'organized' ? 'AI 整理' : `标准脚本 ${scriptSource.format}（${standardCarrier}）`}</strong> · {scriptSource.route === 'organized' ? `${shotText(scriptSource.file_name) || '未登记原文件'} · ` : ''}{shotText(scriptSource.project_info?.['片名']) || '未填写片名'} · {shots.length} 镜 · 待确认 {pendingReviewTotal(shots)} 条{scriptSource.route === 'organized' ? ' · 正文未确认不能生成' : ''}</span>
      {scriptSource.voice_mode === 'verbatim' ? <span>口播按原文逐字切分，分段位置由 AI 决定，请检查每镜起止</span> : null}
      <label><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />只看待确认</label>
    </div> : <div className="template-workspace-banner"><span><strong>旧任务（0.5.16 前生成）</strong> · 部分字段无原始信息</span></div>}
    {visibleShots.map(({ shot, index }) => {
      const shotNo = typeof shot.shot === 'number' ? shot.shot : index + 1
      const timing = shotText(shot.time_range) || (shot.duration ? `${shot.duration}s` : '')
      const selections = selectionsByShot[shot.shot_id]
        || selectionsFromBindings(shot)
      const visibleSelections = shot.material_resolution?.strategy === 'library'
        ? selectionsFromBindings(shot)
        : selections
      const scriptMeta = readScriptMeta(shot)
      const isTemplateShot = Boolean(scriptMeta)
      const pending = pendingReviewCount(shot)
      return <article id={`shot-editor-${index}`} key={shot.shot_id} className={`shot-preview-item shot-editor-item${isTemplateShot ? ' is-template-shot' : ''}`}>
        <div className="shot-preview-index">{String(shotNo).padStart(2, '0')}</div>
        <div className="shot-preview-main shot-editor-main">
          <div className="shot-preview-head">
            <strong>{shotText(shot.title) || `分镜 ${shotNo}`}</strong>
            <span>{shotText(scriptMeta?.segment) ? `段落：${shotText(scriptMeta?.segment)} · ` : ''}{timing}</span>
            {isTemplateShot && pending ? <span className="template-review-badge">!{pending}</span> : null}
            {derivedReviewStatus(shot) === 'pending' ? <span className="template-status-pending">● 待确认</span> : null}
            {derivedReviewStatus(shot) === 'confirmed' ? <span className="template-status-confirmed">● 已确认</span> : null}
          </div>
          <TemplateShotFields
              shot={shot}
              shotIndex={index}
              dictionaries={scriptSource?.dictionaries || {}}
              projectInfo={scriptSource?.project_info}
              showOrigins={scriptSource?.route === 'organized'}
              onChange={onChange}
              onMetaChange={onMetaChange}
              onConfirmReview={onConfirmReview}
              onAcknowledgeWarning={onAcknowledgeWarning}
              onRestoreField={onRestoreField}
            />
          <ShotMaterialBinding
            selections={visibleSelections}
            allowMaterialBindings={allowMaterialBindings}
            downloadMaterial={shot.download_material}
            resolution={shot.material_resolution}
            onOpen={() => onOpenPicker(index)}
            onRemove={(selection) => onRemoveSelection(index, selection)}
            onModeChange={(downloadMaterial) => onMaterialModeChange(index, downloadMaterial)}
          />
        </div>
      </article>
    })}
    {pendingOnly && !visibleShots.length ? <EmptyState title="没有待确认项" description="所有模板提醒都已确认。" /> : null}
  </div>
}

const TEMPLATE_FIELD_LABELS: Record<string, string> = {
  title: '分镜标题', voice_text: '口播文案', subtitle: '字幕', card_content: '上屏内容', card_layout: '版式',
  module_label: '段落', duration: '时长', visual_description: '画面内容', shot_size: '景别',
  camera_move: '运镜', camera_angle: '拍摄角度', card_hint: '卡片提示', material_source: '推荐素材来源',
  material_requirements: '素材要求', search_keywords: '搜索关键词', transition: '转场', notes: '备注', review: '来源/核对',
}

const EDITABLE_REVIEW_FIELDS: Partial<Record<EditableShotField, string>> = {
  download_query: 'search_keywords',
  clip_requirements: 'material_requirements',
}

function TemplateShotFields({
  shot,
  shotIndex,
  dictionaries,
  projectInfo,
  showOrigins,
  onChange,
  onMetaChange,
  onConfirmReview,
  onAcknowledgeWarning,
  onRestoreField,
}: {
  shot: ShotDraft
  shotIndex: number
  dictionaries: Partial<Record<ShotScriptMetaField, string[]>>
  projectInfo?: Record<string, unknown>
  showOrigins: boolean
  onChange: (index: number, field: EditableShotField, value: string) => void
  onMetaChange: (index: number, field: ShotScriptMetaField, value: string) => void
  onConfirmReview: (index: number, fields: string[] | 'all') => void
  onAcknowledgeWarning: (index: number, id: string) => void
  onRestoreField: (index: number, field: RestorableScriptField) => void
}) {
  const meta = readScriptMeta(shot)
  const legacy = !meta
  const origin = showOrigins ? readFieldOrigin(shot) : {}
  const review = readShotScriptReview(shot) || {}
  const confirmed = new Set(Array.isArray(review.confirmed) ? review.confirmed.filter((item): item is string => typeof item === 'string') : [])
  const pendingSuggestions = Array.from(new Set(
    (Array.isArray(review.ai_suggested) ? review.ai_suggested : [])
      .filter((field): field is string => typeof field === 'string' && !confirmed.has(field)),
  ))
  const acknowledged = new Set(Array.isArray(review.acknowledged) ? review.acknowledged.filter((item): item is string => typeof item === 'string') : [])
  const warnings = (Array.isArray(review.warnings) ? review.warnings : []).filter((warning): warning is ScriptImportIssue => (
    Boolean(warning) && typeof warning === 'object' && !Array.isArray(warning)
      && typeof warning.code === 'string' && Boolean(warning.code)
      && typeof warning.message === 'string' && Boolean(warning.message)
  )).filter((warning) => (
    warning.code !== 'ai_suggested' && !acknowledged.has(warningReviewId(warning))
  ))
  const cardLayoutDisabled = nonEmptyLines(shot.card_content) < 2

  const changeMeta = (field: ShotScriptMetaField, value: string) => onMetaChange(shotIndex, field, value)
  return <div className="template-shot-fields">
    <h4 className="template-field-group-title">观众听到和看到的</h4>
    <TemplateTextField label="分镜标题" field="title" shot={shot} singleLine suggested={pendingSuggestions.includes('title')} origin={origin.title} onChange={(value) => onChange(shotIndex, 'title', value)} onRestore={onRestoreField} shotIndex={shotIndex} />
    <TemplateTextField label="口播文案" field="voice_text" shot={shot} rows={3} suggested={pendingSuggestions.includes('voice_text')} origin={origin.voice_text} onChange={(value) => onChange(shotIndex, 'voice_text', value)} onRestore={onRestoreField} shotIndex={shotIndex} />
    <TemplateTextField label="字幕" field="subtitle" shot={shot} rows={2} suggested={pendingSuggestions.includes('subtitle')} origin={origin.subtitle} placeholder="留空 = 同口播" onChange={(value) => onChange(shotIndex, 'subtitle', value)} onRestore={onRestoreField} shotIndex={shotIndex} />

    <section className="template-card-editor">
      <div className="template-authored-card"><strong>上屏原文</strong><span>{legacy ? '旧任务无此信息' : shotText(meta.authored && typeof meta.authored === 'object' && !Array.isArray(meta.authored) ? meta.authored.card_content : '') || '（未填写）'}</span></div>
      <TemplateTextField label="上屏内容" field="card_content" shot={shot} rows={3} suggested={pendingSuggestions.includes('card_content')} origin={origin.card_content} onChange={(value) => onChange(shotIndex, 'card_content', value)} onRestore={onRestoreField} shotIndex={shotIndex} />
      <label className={`shot-editor-field template-layout-field${pendingSuggestions.includes('card_layout') ? ' is-suggested' : ''}`}>
        <span>版式{origin.card_layout ? <OriginLabel origin={origin.card_layout} /> : null}</span>
        <select disabled={cardLayoutDisabled} value={cardLayoutDisabled ? '' : shotText(shot.card_layout)} onChange={(event) => onChange(shotIndex, 'card_layout', event.target.value)}>
          <option value="">自动</option>
          <option value="headline_sub">大字+小字</option>
          <option value="equal_lines">各行一样大</option>
        </select>
        {pendingSuggestions.includes('card_layout') ? <button className="text-button" type="button" onClick={() => onConfirmReview(shotIndex, ['card_layout'])}>确认</button> : null}
        {!cardLayoutDisabled && isScriptFieldModified(shot, 'card_layout') ? <ModifiedControl restoreLabel={origin.card_layout === 'ai' ? '恢复整理结果' : '恢复原文'} onRestore={() => onRestoreField(shotIndex, 'card_layout')} /> : null}
      </label>
    </section>

    <ReviewReadonly label="卡片提示" value={legacy ? '旧任务无此信息' : shot.card_hint} origin={origin.card_hint} pending={pendingSuggestions.includes('card_hint')} onConfirm={() => onConfirmReview(shotIndex, ['card_hint'])} />
    <h4 className="template-field-group-title">画面和素材</h4>
    {legacy
      ? <label className="shot-editor-field template-text-field"><span>画面内容</span><textarea value={shotText(shot.visual_query)} onChange={(event) => onChange(shotIndex, 'visual_query', event.target.value)} rows={3} /></label>
      : <TemplateTextField label="画面内容" field="visual_description" shot={shot} rows={3} origin={origin.visual_description} onChange={(value) => changeMeta('visual_description', value)} onRestore={onRestoreField} shotIndex={shotIndex} suggested={pendingSuggestions.includes('visual_description')} />}

    <div className="template-select-grid">
      {(['shot_size', 'camera_move', 'camera_angle', 'transition'] as ShotScriptMetaField[]).map((field) => <TemplateSelect
        key={field}
        field={field}
        label={TEMPLATE_FIELD_LABELS[field]}
        value={shotText(meta?.[field])}
        options={dictionaries[field] || []}
        suggested={pendingSuggestions.includes(field)}
        modified={isScriptFieldModified(shot, field)}
        disabled={legacy}
        unavailable={legacy}
        origin={origin[field]}
        onChange={(value) => changeMeta(field, value)}
        onConfirm={() => onConfirmReview(shotIndex, [field])}
        onRestore={() => onRestoreField(shotIndex, field)}
      />)}
    </div>

    <div className="shot-editor-grid template-existing-fields">
      {editableFields.filter((field) => ['download_query', 'clip_requirements'].includes(field.key)).map((field) => {
        const reviewField = EDITABLE_REVIEW_FIELDS[field.key]
        const suggested = Boolean(reviewField && pendingSuggestions.includes(reviewField))
        return <label key={field.key} className={`shot-editor-field${suggested ? ' is-suggested' : ''}`}>
        <span>{field.key === 'download_query' ? '搜索关键词' : field.key === 'clip_requirements' ? '素材要求' : field.label}{origin[reviewField || ''] ? <em className="template-origin">{origin[reviewField || ''] === 'script' ? '脚本' : origin[reviewField || ''] === 'ai' ? 'AI 整理' : '默认'}</em> : null}</span>
        <textarea value={shotText(shot[field.key])} onChange={(event) => onChange(shotIndex, field.key, event.target.value)} placeholder={field.placeholder} rows={field.rows || 2} />
        {suggested ? <button className="text-button" type="button" onClick={() => onConfirmReview(shotIndex, [reviewField!])}>确认</button> : null}
      </label>})}
    </div>

    {pendingSuggestions.length ? <div className="template-review-actions">
      <span>AI 建议，待确认：{pendingSuggestions.map((field) => TEMPLATE_FIELD_LABELS[field] || field).join('、')}</span>
      {pendingSuggestions.map((field) => <button key={field} className="text-button" type="button" onClick={() => onConfirmReview(shotIndex, [field])}>确认{TEMPLATE_FIELD_LABELS[field] || field}</button>)}
      <button className="text-button" type="button" onClick={() => onConfirmReview(shotIndex, 'all')}>本镜全部确认</button>
    </div> : null}

    <details className="template-more-fields">
      <summary><ChevronDown />更多（只读）</summary>
      <dl>
        <ReviewReadonly term label="段落" value={meta?.segment} origin={origin.module_label} pending={pendingSuggestions.includes('module_label')} onConfirm={() => onConfirmReview(shotIndex, ['module_label'])} />
        <ReviewReadonly term label="时长" value={shot.duration} origin={origin.duration} pending={pendingSuggestions.includes('duration')} onConfirm={() => onConfirmReview(shotIndex, ['duration'])} />
        <ReviewReadonly term label="推荐素材来源" value={meta?.material_source} origin={origin.material_source} pending={pendingSuggestions.includes('material_source')} onConfirm={() => onConfirmReview(shotIndex, ['material_source'])} />
        <ReviewReadonly term label="备注" value={meta?.notes} origin={origin.notes} pending={pendingSuggestions.includes('notes')} onConfirm={() => onConfirmReview(shotIndex, ['notes'])} />
        <dt>来源/核对</dt><dd>{(Array.isArray(review.status_lines) ? review.status_lines.filter((item): item is string => typeof item === 'string').join('\n') : '') || shotText(review.status) || '（无）'}</dd>
        {meta?.extra_columns && typeof meta.extra_columns === 'object' && !Array.isArray(meta.extra_columns)
          ? Object.entries(meta.extra_columns).map(([key, value]) => <div className="template-more-row" key={key}><dt>{key}</dt><dd>{shotText(value)}</dd></div>)
          : null}
        {projectInfo ? Object.entries(projectInfo).map(([key, value]) => <div className="template-more-row" key={`project:${key}`}><dt>项目 · {key}</dt><dd>{shotText(value)}</dd></div>) : null}
      </dl>
    </details>

    {warnings.length ? <div className="template-warning-list">
      {warnings.map((warning, warningIndex) => {
        const id = warningReviewId(warning)
        return <div key={`${id}:${warningIndex}`}><span>[{warning.code}] {warning.message}</span><button className="text-button" type="button" onClick={() => onAcknowledgeWarning(shotIndex, id)}>知道了</button></div>
      })}
    </div> : null}
  </div>
}

function OriginLabel({ origin }: { origin: 'script' | 'ai' | 'default' }) {
  return <em className="template-origin">{origin === 'script' ? '脚本' : origin === 'ai' ? 'AI 整理' : '默认'}</em>
}

function ReviewReadonly({ label, value, origin, pending, onConfirm, term = false }: {
  label: string
  value: unknown
  origin?: 'script' | 'ai' | 'default'
  pending: boolean
  onConfirm: () => void
  term?: boolean
}) {
  const labelContent = <>{label}{origin ? <OriginLabel origin={origin} /> : null}</>
  const content = <><strong>{labelContent}</strong><span>{shotText(value) || '（无）'}</span>{pending ? <button className="text-button" type="button" onClick={onConfirm}>确认</button> : null}</>
  return term
    ? <div className={`template-more-row${pending ? ' is-suggested' : ''}`}><dt>{labelContent}</dt><dd>{shotText(value) || '（无）'}{pending ? <button className="text-button" type="button" onClick={onConfirm}>确认</button> : null}</dd></div>
    : <div className={`template-readonly-line${pending ? ' is-suggested' : ''}`}>{content}</div>
}

function TemplateTextField({ label, field, shot, shotIndex, singleLine = false, rows = 2, placeholder, suggested = false, origin, onChange, onRestore }: {
  label: string
  field: RestorableScriptField
  shot: ShotDraft
  shotIndex: number
  singleLine?: boolean
  rows?: number
  placeholder?: string
  suggested?: boolean
  origin?: 'script' | 'ai' | 'default'
  onChange: (value: string) => void
  onRestore: (index: number, field: RestorableScriptField) => void
}) {
  const value = shotText(currentScriptFieldValue(shot, field))
  return <label className={`shot-editor-field template-text-field${singleLine ? ' title-field' : ''}${suggested ? ' is-suggested' : ''}`}>
    <span>{label}{origin ? <em className="template-origin">{origin === 'script' ? '脚本' : origin === 'ai' ? 'AI 整理' : '默认'}</em> : null}</span>
    {singleLine
      ? <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      : <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={rows} />}
    {isScriptFieldModified(shot, field) ? <ModifiedControl restoreLabel={origin === 'ai' ? '恢复整理结果' : '恢复原文'} onRestore={() => onRestore(shotIndex, field)} /> : null}
  </label>
}

function ModifiedControl({ onRestore, restoreLabel = '恢复原文' }: { onRestore: () => void; restoreLabel?: string }) {
  return <span className="template-modified"><em>人已改</em><button className="text-button" type="button" onClick={onRestore}>{restoreLabel}</button></span>
}

function TemplateSelect({ field, label, value, options, suggested, modified, disabled = false, unavailable = false, origin, onChange, onConfirm, onRestore }: {
  field: ShotScriptMetaField
  label: string
  value: string
  options: string[]
  suggested: boolean
  modified: boolean
  onChange: (value: string) => void
  onConfirm: () => void
  onRestore: () => void
  disabled?: boolean
  unavailable?: boolean
  origin?: 'script' | 'ai' | 'default'
}) {
  const unknownValue = value && !options.includes(value)
  return <label className={`shot-editor-field template-select-field${suggested ? ' is-suggested' : ''}`}>
    <span>{label}{origin ? <em className="template-origin">{origin === 'script' ? '脚本' : origin === 'ai' ? 'AI 整理' : '默认'}</em> : null}</span>
    <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
      {unavailable ? <option value="">旧任务无此信息</option> : null}
      {field === 'transition' ? <option value="">硬切（默认）</option> : <option value="">不限</option>}
      {unknownValue ? <option value={value}>{value}（非字典值）</option> : null}
      {options.filter((option) => field === 'transition' || option !== '不限').map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
    {suggested ? <button className="text-button" type="button" onClick={onConfirm}>确认</button> : null}
    {modified ? <ModifiedControl restoreLabel={origin === 'ai' ? '恢复整理结果' : '恢复原文'} onRestore={onRestore} /> : null}
  </label>
}

function ShotMaterialBinding({
  selections,
  allowMaterialBindings,
  downloadMaterial,
  resolution,
  onOpen,
  onRemove,
  onModeChange,
}: {
  selections: ShotMaterialSelection[]
  allowMaterialBindings: boolean
  downloadMaterial: boolean
  resolution?: ShotDraft['material_resolution']
  onOpen: () => void
  onRemove: (selection: ShotMaterialSelection) => void
  onModeChange: (downloadMaterial: boolean) => void
}) {
  const summary = summarizeShotMaterialSelections(selections)

  if (!allowMaterialBindings) {
    return <section className="shot-editor-material-binding material-binding-inactive">
      <div className="shot-editor-material-head">
        <span>
          <strong>分镜素材 · 仅 Pexels</strong>
          <em>{selections.length ? '已绑定范围在当前模式下不生效' : '当前模式直接从 Pexels 下载'}</em>
        </span>
        <button className="button" type="button" disabled title="仅 Pexels 模式不能手工绑定素材范围">
          <FolderClosed className="button-icon" />选择素材
        </button>
      </div>
      {selections.length ? <div className="shot-editor-material-chips">
        {selections.map((selection) => <span key={`${selection.kind}:${selection.id}`}>
          {selection.kind === 'folder' ? <FolderClosed /> : <FileVideo2 />}
          <strong>{selection.name}</strong>
        </span>)}
      </div> : null}
    </section>
  }

  if (downloadMaterial) {
    return <section className="shot-editor-material-binding">
      <div className="shot-editor-material-head">
        <span>
          <strong>分镜素材</strong>
          <em>{resolution?.strategy === 'download'
            ? `${resolution.reason === 'local_priority_disabled' || resolution.reason === 'pexels_only' ? '跳过素材库匹配' : '素材库未命中'}，将从 ${materialSourceLabel(resolution.fallback_source)} 下载`
            : '按工作台的素材来源模式获取素材'}</em>
        </span>
        <div className="shot-editor-material-actions">
          <div className="shot-editor-material-mode" role="group" aria-label="分镜素材来源">
            <button className="active" type="button">自动获取</button>
            <button type="button" onClick={() => onModeChange(false)}>指定素材</button>
          </div>
          <button className="button" type="button" disabled>
            <FolderClosed className="button-icon" />选择素材
          </button>
        </div>
      </div>
    </section>
  }

  return <section className="shot-editor-material-binding">
    <div className="shot-editor-material-head">
      <span>
        <strong>分镜素材</strong>
        <em>{selections.length
          ? `${summary.fileCount} 个视频 · ${summary.folderCount} 个文件夹${summary.candidateCount === null ? '' : ` · ${summary.candidateCount} 个候选视频`}`
          : '未指定素材，生成时按工作台的素材来源模式自动获取'}</em>
      </span>
      <div className="shot-editor-material-actions">
        <div className="shot-editor-material-mode" role="group" aria-label="分镜素材来源">
          <button type="button" onClick={() => onModeChange(true)}>自动获取</button>
          <button className="active" type="button">指定素材</button>
        </div>
        <button className="button" type="button" onClick={onOpen}>
        <FolderClosed className="button-icon" />选择素材
        </button>
      </div>
    </div>
    {selections.length ? <div className="shot-editor-material-chips">
      {selections.map((selection) => <span
        className={selection.kind === 'folder' ? 'is-folder' : undefined}
        key={`${selection.kind}:${selection.id}`}
      >
        {selection.kind === 'folder' ? <FolderClosed /> : <FileVideo2 />}
        <strong>{selection.name}</strong>
        {selection.kind === 'folder' && selection.includeSubfolders ? <em>含子文件夹</em> : null}
        <button type="button" aria-label={`移除 ${selection.name}`} onClick={() => onRemove(selection)}><X /></button>
      </span>)}
    </div> : null}
  </section>
}

function materialSourceLabel(value?: string): string {
  if (value === 'pixabay') return 'Pixabay'
  if (value === 'wikimedia-commons') return 'Wikimedia Commons'
  if (value === 'default') return '默认素材源'
  return 'Pexels'
}

function selectionsFromBindings(shot: ShotDraft): ShotMaterialSelection[] {
  return materialBindingsToSelections(shot.material_bindings).map((selection) => (
    selection.kind === 'file'
      && selection.id === shot.material_resolution?.material_id
      && shot.material_resolution.material_name
      ? { ...selection, name: shot.material_resolution.material_name }
      : selection
  ))
}
