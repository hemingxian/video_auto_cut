import { FileJson, FileText, Play, Terminal } from 'lucide-react'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { PageLayout } from './components/common/PageLayout'
import { Panel } from './components/common/Panel'
import { Sidebar } from './components/layout/Sidebar'
import type { MaterialUiMetadataMap } from './pages/materials/materialLibraryUiModel'
import { ShotEditorDrawer } from './pages/start/ShotEditorDrawer'
import { MaterialErrorDetail, type ShotMaterialSelection } from './pages/start/ShotMaterialPickerDialog'
import { ScriptFilesDialog } from './pages/start/ScriptFilesDialog'
import { TaskQueuePopover } from './pages/start/TaskQueuePopover'
import { VoiceScriptBodyDialog } from './pages/start/VoiceScriptBodyDialog'
import type { ShotDraft } from './pages/start/types'
import { acknowledgeShotWarning, bodyReviewGate, confirmShotReview, restoreScriptValue, updateShotContent, updateShotScriptMeta } from './pages/start/shotPlan'
import type { MaterialDirectoryListing, RunItem } from './types/videoauto'
import './style.css'

// Development-renderer fixture bridge. Product components stay unchanged;
// only native IPC/file/model sources are replaced for browser review.
;(window as unknown as { videoAutoCut: Record<string, unknown> }).videoAutoCut = {
  onMaterialLibraryEvent: () => () => undefined,
  cancelMaterialImport: async () => ({ ok: true }),
  summarizeMaterialSelection: async () => ({ candidateCount: 0, entries: [] }),
  getMaterialFolderDetails: async () => previewListing.current,
  resolveMaterialSelection: async () => ({ ok: true }),
  importMaterials: async () => [],
  readVoiceScriptSource: async (source: string) => source.includes('口播稿二')
    ? '# 第二份口播稿\n\n## 项目信息\n片名：城市能源\n\n## 正文\n第三段是第二份文件独立原文。\n\n第四段也只属于第二份文件。'
    : '# 产品口播稿\n\n## 项目信息\n片名：智能储能\n\n## 正文\n第一段逐字口播。\n\n第二段逐字口播。',
  writeVoiceScriptBody: async (_source: string, _body: string, taskId: string) => `D:\\preview\\temp\\voice_script_body_${taskId}.txt`,
}

const previewShots: ShotDraft[] = [
  {
    shot_id: 'shot_preview_01',
    shot: 1,
    title: '开场：城市与清洁能源',
    duration: 8,
    time_range: '00:00–00:08',
    voice_text: '每一次能源革新，都在重新定义城市的未来。',
    download_query: '现代城市 天际线 清洁能源',
    visual_query: '清晨城市天际线，阳光穿过高楼，镜头缓慢推进。',
    clip_requirements: '节奏舒缓，使用淡入转场，画面保持稳定。',
    download_material: false,
    material_bindings: [],
  },
  {
    shot_id: 'shot_preview_02',
    shot: 2,
    title: '核心：智能储能产品展示',
    duration: 12,
    time_range: '00:08–00:20',
    voice_text: '智能储能系统，让每一度电都得到更高效、更可靠的利用。',
    download_query: '储能设备 产品细节 工业设计',
    visual_query: '白色智能储能设备特写，展示屏、接口和模块化结构。',
    clip_requirements: '从全景切换到三处细节特写，转场干净，突出科技感。',
    download_material: false,
    material_bindings: [],
  },
  {
    shot_id: 'shot_preview_03',
    shot: 3,
    title: '应用：园区能源调度',
    duration: 9,
    time_range: '00:20–00:29',
    voice_text: '从园区到家庭，系统实时响应每一个用能需求。',
    download_query: '工业园区 能源管理 控制中心',
    visual_query: '现代工业园区航拍和控制中心操作画面交替出现。',
    clip_requirements: '保持蓝绿色调，画面之间使用快速叠化。',
    download_material: false,
    material_bindings: [],
  },
  {
    shot_id: 'shot_preview_04',
    shot: 4,
    title: '结尾：品牌愿景',
    duration: 7,
    time_range: '00:29–00:36',
    voice_text: '让绿色能源，成为每个未来日常的一部分。',
    download_query: '夕阳 风力发电 光伏板',
    visual_query: '夕阳下的风机与光伏板，最后淡出品牌标志。',
    clip_requirements: '镜头拉远，最后两秒保留品牌卡片。',
    download_material: true,
    material_bindings: [],
  },
]

const previewListing: MaterialDirectoryListing = {
  current: {
    id: 'root',
    name: '全部素材',
    kind: 'user',
    canCreate: true,
    folderCount: 4,
    videoCount: 6,
  },
  breadcrumbs: [{ id: 'root', name: '全部素材' }],
  rootFolders: [
    { id: 'folder-product', name: '产品展示', kind: 'user', videoCount: 12, folderCount: 2 },
    { id: 'folder-downloads', name: '云端素材', kind: 'cloud', videoCount: 0, folderCount: 0 },
  ],
  folders: [
    { id: 'folder-product', name: '产品展示', kind: 'user', videoCount: 12, folderCount: 2 },
    { id: 'folder-factory', name: '工业园区', kind: 'user', videoCount: 18, folderCount: 3 },
    { id: 'folder-city', name: '城市空镜', kind: 'user', videoCount: 16, folderCount: 1 },
    { id: 'folder-interview', name: '人物访谈', kind: 'user', videoCount: 8, folderCount: 0 },
  ],
  files: [
    {
      name: '智能储能柜_正面展示.mp4',
      path: 'preview/storage-front.mp4',
      url: '',
      size: 118_489_088,
      mtime: Date.parse('2026-07-30T09:28:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '触控屏_操作特写.mp4',
      path: 'preview/touch-screen.mp4',
      url: '',
      size: 78_643_200,
      mtime: Date.parse('2026-07-29T18:42:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '模块接口_细节镜头.mov',
      path: 'preview/module-detail.mov',
      url: '',
      size: 96_468_992,
      mtime: Date.parse('2026-07-28T14:16:00+08:00'),
      ext: '.mov',
    },
    {
      name: '园区航拍_清晨.mp4',
      path: 'preview/park-drone.mp4',
      url: '',
      size: 224_395_264,
      mtime: Date.parse('2026-07-27T07:55:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '控制中心_监控大屏.mp4',
      path: 'preview/control-room.mp4',
      url: '',
      size: 134_952_960,
      mtime: Date.parse('2026-07-26T21:07:00+08:00'),
      ext: '.mp4',
    },
    {
      name: '城市天际线_日落.mp4',
      path: 'preview/city-sunset.mp4',
      url: '',
      size: 163_577_856,
      mtime: Date.parse('2026-07-25T11:36:00+08:00'),
      ext: '.mp4',
    },
  ],
}

const previewMetadata: MaterialUiMetadataMap = {
  'preview/storage-front.mp4': { thumbnailTone: 'studio' },
  'preview/touch-screen.mp4': { thumbnailTone: 'teal' },
  'preview/module-detail.mov': { thumbnailTone: 'night' },
  'preview/park-drone.mp4': { thumbnailTone: 'forest' },
  'preview/control-room.mp4': { thumbnailTone: 'city' },
  'preview/city-sunset.mp4': { thumbnailTone: 'coast' },
}

const productFolder = previewListing.folders[0]
const factoryFolder = previewListing.folders[1]
const selectedFront = previewListing.files[0]
const selectedScreen = previewListing.files[1]

const previewSelections: Record<number, ShotMaterialSelection[]> = {
  0: [{
    id: 'folder-city',
    kind: 'folder',
    name: '城市空镜',
    includeSubfolders: false,
    videoCount: 16,
    folder: previewListing.folders[2],
  }],
  1: [
    {
      id: productFolder.id,
      kind: 'folder',
      name: productFolder.name,
      includeSubfolders: true,
      videoCount: productFolder.videoCount,
      folder: productFolder,
    },
    {
      id: factoryFolder.id,
      kind: 'folder',
      name: factoryFolder.name,
      includeSubfolders: false,
      videoCount: factoryFolder.videoCount,
      folder: factoryFolder,
    },
    {
      id: selectedFront.path,
      kind: 'file',
      name: selectedFront.name,
      file: selectedFront,
    },
    {
      id: selectedScreen.path,
      kind: 'file',
      name: selectedScreen.name,
      file: selectedScreen,
    },
  ],
}

const previewRun: RunItem = {
  id: 'draft_20260730_001',
  projectName: '智能储能品牌宣传片',
  path: '',
  mtime: Date.now(),
  logPath: '',
  shotsPath: '',
  finalVideo: '',
  artifacts: [],
}

export function TaskEditorPreview() {
  const params = new URLSearchParams(window.location.search)
  const showPicker = params.get('state') === 'picker'
  const route = params.get('route') || 'organized'
  const voiceFixture = params.get('voice') === '1'
  const initial = previewShots.slice(0, 2).map((shot, index) => route === 'legacy' ? shot : ({
    ...shot,
    subtitle: voiceFixture ? '' : index ? '' : '每一次能源革新，正在重塑城市。',
    card_content: index ? '智能储能\n高效可靠' : '绿色能源\n城市未来',
    card_layout: 'headline_sub',
    script_meta: {
      v: 1,
      segment: index ? '核心产品' : '开场',
      visual_description: shot.visual_query,
      shot_size: index ? '特写' : '全景', camera_move: '缓慢推进', camera_angle: '平视', transition: '',
      script_values: { title: shot.title, voice_text: shot.voice_text, subtitle: voiceFixture ? '' : index ? '' : '每一次能源革新，正在重塑城市。', card_content: index ? '智能储能\n高效可靠' : '绿色能源\n城市未来', card_layout: 'headline_sub', visual_description: shot.visual_query, shot_size: index ? '特写' : '全景', camera_move: '缓慢推进', camera_angle: '平视', transition: '' },
      authored: { card_content: index ? '智能储能\n高效可靠' : '绿色能源\n城市未来' },
      field_origin: route === 'organized' ? { title: 'ai', voice_text: voiceFixture || index ? 'script' : 'ai', subtitle: 'script', card_content: 'script', visual_description: 'ai', shot_size: 'script' } : {},
      review: route === 'organized' ? { status: '待确认', ai_suggested: ['title', ...(voiceFixture || index ? [] : ['voice_text']), 'visual_description'], confirmed: [], warnings: [], acknowledged: [] } : { status: '已确认', ai_suggested: [], confirmed: [], warnings: [], acknowledged: [] },
    },
  })) as ShotDraft[]
  const [shots, setShots] = useState(initial)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [notice, setNotice] = useState('')
  const [importCount, setImportCount] = useState(0)
  const [voiceModes, setVoiceModes] = useState<Record<string, boolean>>({})
  const [voiceBodies, setVoiceBodies] = useState<Record<string, string>>({})
  const [voiceTaskIds, setVoiceTaskIds] = useState<Record<string, string>>({})
  const planRoot = route === 'legacy' ? {} : { script_source: { route, format: 'VAC-SB-1', file_name: route === 'template' ? '示例_智能储能_v1.xlsx' : '智能储能散文.md', voice_mode: params.get('voice') === '1' ? 'verbatim' : undefined, project_info: { 片名: '智能储能品牌宣传片' }, dictionaries: { shot_size: ['不限', '全景', '特写'], camera_move: ['不限', '缓慢推进'], camera_angle: ['不限', '平视'], transition: ['淡入淡出'] } } }
  if (params.get('state') === 'voice-preview') return <><p className="preview-fixture-status">导入次数：{importCount}；{notice || '等待操作'}</p><VoiceScriptBodyDialog source={'# 产品口播稿\n\n## 项目信息\n片名：智能储能\n客户：示例\n\n## 正文\n第一段逐字口播。\n\n第二段逐字口播。'} onCancel={() => setNotice('已取消，本轮未入队')} onConfirm={(body) => { setImportCount((count) => count + 1); setNotice(`已确认 ${body.length} 字`) }} /></>
  if (params.get('state') === 'material-errors') return <main style={{ padding: 40 }}><h1>素材错误详情</h1><MaterialErrorDetail title="读取素材库失败详情" detail="NotFoundError: 素材目录不存在" /><MaterialErrorDetail title="范围统计失败详情" detail="EACCES: access denied" /></main>
  if (params.get('state') === 'voice-blocked') return <main style={{ padding: 40 }}><h1>口播稿导入拦截</h1><TaskQueuePopover items={[{
    id: 'fixture-voice-blocked', mode: 'plan', title: '口播稿二.md', status: 'failed', createdAt: new Date(0).toISOString(),
    downloadNewMaterials: true, voiceScript: true, scriptPath: 'D:\\fixture\\口播稿二.md', logs: [],
    scriptImport: { route: 'organized', format: 'voice-script', file: '口播稿二.md', shots: 2, blocked: [{ code: 'voice_script_mismatch', shot: 2, column: '口播文案', message: '正文第 46 字不一致；期望「让每一度电都高效利用」，实际「让每一度电更高效利用」', action: '重新选择脚本并核对第 2 镜口播正文' }], warnings: [] },
  }]} selectedId="fixture-voice-blocked" running={false} paused onSelect={() => undefined} onStop={() => undefined} onPauseAll={() => undefined} onContinue={() => undefined} onResume={() => undefined} onRemove={() => undefined} /></main>
  if (params.get('state') === 'voice-entry') return <><p className="preview-fixture-status">导入次数：{importCount}；{notice || '等待操作'}</p><ScriptFilesDialog open scripts={'D:\\fixture\\口播稿.txt\nD:\\fixture\\口播稿二.md\nD:\\fixture\\标准模板.xlsx'} aspectRatio="16:9" outputResolution="1080p" onAspectRatioChange={() => undefined} onOutputResolutionChange={() => undefined} materialSelections={{}} onMaterialsChange={() => undefined} onClose={() => undefined} onChooseScripts={() => undefined} onScriptsChange={() => undefined} voiceScriptModes={voiceModes} voiceScriptBodyPaths={voiceBodies} voiceScriptTaskIds={voiceTaskIds} onVoiceScriptChange={(scriptPath, enabled, bodyPath) => {
    const key = scriptPath.replace(/\\/g, '/').toLowerCase()
    setVoiceModes((current) => ({ ...current, [key]: enabled }))
    setVoiceBodies((current) => bodyPath ? { ...current, [key]: bodyPath } : current)
    setVoiceTaskIds((current) => ({ ...current, [key]: current[key] || (key.includes('口播稿二') ? 'fixture-task-002' : 'fixture-task-001') }))
  }} onImportAndPlan={() => { setImportCount((count) => count + 1); setNotice('已入预览队列') }} onImportAndGenerate={() => { setImportCount((count) => count + 1); setNotice('已入生成队列') }} /></>
  return <div className="app-shell">
    <Sidebar
      activePage="start"
      auth={{
        loggedIn: true,
        user: {
          id: 'preview-user',
          displayName: '设计验收',
          balance: 128,
        },
      }}
      onNavigate={() => undefined}
      onAccount={() => undefined}
    />
    <main className="main-area">
      <div className="page-view">
        <PageLayout
          className="start-page"
          title="开始任务"
          action={<div className="button-row">
            <button className="button" type="button"><FileText className="button-icon" />脚本文件</button>
            <button className="button" type="button"><Terminal className="button-icon" />查看日志</button>
            <button className="button" type="button"><FileJson className="button-icon" />预览分镜</button>
            <button className="button primary" type="button" onClick={() => {
              const gate = bodyReviewGate(shots)
              setNotice(gate.blocked ? gate.message : '可以生成')
              if (gate.blocked) {
                setDrawerOpen(true)
                window.setTimeout(() => document.getElementById(`shot-editor-${gate.firstIndex}`)?.scrollIntoView({ block: 'center' }), 0)
              }
            }}><Play className="button-icon" />生成视频</button>
          </div>}
        >
          {notice ? <div className="saved-toast">{notice}</div> : null}
          <div className="content-grid start-grid">
            <Panel className="workflow-panel">
              <div className="panel-title">当前流程</div>
            </Panel>
            <Panel className="shot-workspace-panel">
              <div className="panel-title">分镜工作区</div>
            </Panel>
          </div>
        </PageLayout>
      </div>
    </main>
    <ShotEditorDrawer
      open={drawerOpen}
      topic="智能储能，让绿色能源触手可及"
      shots={shots}
      planRoot={planRoot}
      dirty={false}
      draftSaveStatus="saved"
      draftSavedAt="18:42"
      currentRun={previewRun}
      message=""
      initialSelectedIndex={1}
      initialMaterialSelections={previewSelections}
      materialListing={previewListing}
      materialMetadata={previewMetadata}
      pickerInitiallyOpen={showPicker}
      onClose={() => setDrawerOpen(false)}
      onSave={async () => true}
      onRefresh={async () => undefined}
      onTopicChange={() => undefined}
      onShotChange={(index, field, value) => setShots((current) => current.map((shot, itemIndex) => itemIndex === index ? updateShotContent(shot, field, value) : shot))}
      onShotMetaChange={(index, field, value) => setShots((current) => current.map((shot, itemIndex) => itemIndex === index ? updateShotScriptMeta(shot, field, value) : shot))}
      onConfirmReview={(index, fields) => setShots((current) => current.map((shot, itemIndex) => itemIndex === index ? confirmShotReview(shot, fields) : shot))}
      onAcknowledgeWarning={(index, id) => setShots((current) => current.map((shot, itemIndex) => itemIndex === index ? acknowledgeShotWarning(shot, id) : shot))}
      onRestoreField={(index, field) => setShots((current) => current.map((shot, itemIndex) => itemIndex === index ? restoreScriptValue(shot, field) : shot))}
      onShotMaterialsChange={() => undefined}
    />
  </div>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TaskEditorPreview />
  </StrictMode>,
)
