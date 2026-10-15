// ISOLATED FIXTURE: real React picker/model, mock bridge and library only.
// No user database, network service, model, physical input or real video is accessed.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ShotMaterialPickerDialog } from '../src/pages/start/ShotMaterialPickerDialog'
import { materialBindingsToSelections, selectionsToMaterialBindings, type ShotMaterialSelection } from '../src/pages/start/shotMaterialSelectionModel'
import type { ShotMaterialBinding } from '../src/pages/start/types'
import type { FileItem, MaterialDirectoryListing, MaterialFolderNode, MaterialSelectionSummary } from '../src/types/videoauto'
import '../src/style.css'

const fixture: any = { calls: [], checks: [], errors: [], confirms: [], snapshots: [], mounted: 0 }
;(window as any).materialScopeFixture = fixture
window.addEventListener('error', (event) => fixture.errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => fixture.errors.push(String(event.reason)))

const library: MaterialFolderNode = { id: 'library', name: '全部素材', kind: null }
const scara: MaterialFolderNode = { id: 'fld_scara', name: 'scara', kind: 'user', videoCount: 21, folderCount: 2 }
const child: MaterialFolderNode = { id: 'fld_child14', name: 'child14', kind: 'user', videoCount: 14, folderCount: 0 }
const sibling: MaterialFolderNode = { id: 'fld_child7', name: 'child7', kind: 'user', videoCount: 7, folderCount: 0 }
const files: FileItem[] = Array.from({ length: 21 }, (_, index) => ({
  name: `scara-${String(index + 1).padStart(2, '0')}.mp4`, path: `X:/isolated-fixture/scara-${index + 1}.mp4`,
  url: '', size: 1024, mtime: 1, ext: '.mp4', materialId: `mat_${index + 1}`,
  assetId: `asset_${index + 1}`, assetVersion: 1, localStatus: 'present', analysisStatus: 'ready', cloudStatus: 'not_uploaded',
}))
const listings: Record<string, MaterialDirectoryListing> = {
  library: { current: library, breadcrumbs: [library], folders: [scara], files: [] },
  fld_scara: { current: scara, breadcrumbs: [library, scara], folders: [child, sibling], files: [] },
  fld_child14: { current: child, breadcrumbs: [library, scara, child], folders: [], files: files.slice(0, 14) },
  fld_child7: { current: sibling, breadcrumbs: [library, scara, sibling], folders: [], files: files.slice(14) },
}
const allKeys = files.map(file => `asset:${file.assetId}:1`)
function summaryFor(bindings: ShotMaterialBinding[]): MaterialSelectionSummary {
  const entries = bindings.map(binding => {
    if (binding.binding_type === 'material') {
      const index = files.findIndex(file => file.materialId === binding.material_id)
      return { key: `material:${binding.material_id}`, candidateKeys: index >= 0 ? [allKeys[index]] : [] }
    }
    const candidateKeys = binding.folder_id === scara.id
      ? binding.include_subfolders ? allKeys : []
      : binding.folder_id === child.id ? allKeys.slice(0, 14)
      : binding.folder_id === sibling.id ? allKeys.slice(14) : []
    return { key: `folder:${binding.folder_id}`, candidateKeys: [...candidateKeys] }
  })
  return { candidateCount: new Set(entries.flatMap(entry => entry.candidateKeys)).size, entries }
}
let summaryBehavior: ((bindings: ShotMaterialBinding[]) => Promise<MaterialSelectionSummary>) | undefined
let detailBehavior: (() => Promise<MaterialFolderNode>) | undefined
const api: Record<string, (...args: any[]) => any> = {
  browseMaterials: async (options?: { folderId?: string }) => listings[options?.folderId || 'library'],
  onMaterialLibraryEvent: () => () => undefined,
  getMaterialFolderDetails: async () => detailBehavior ? detailBehavior() : scara,
  summarizeMaterialSelection: async ({ bindings }: { bindings: ShotMaterialBinding[] }) => summaryBehavior ? summaryBehavior(bindings) : summaryFor(bindings),
  resolveMaterialSelection: async () => ({ ok: true, files: [] }),
}
;(window as any).videoAutoCut = new Proxy({}, { get(_target, name) {
  return (...args: any[]) => {
    fixture.calls.push({ name: String(name), args: JSON.parse(JSON.stringify(args, (_key, value) => typeof value === 'function' ? '[fixture event listener]' : value)) })
    if (!api[String(name)]) throw new Error(`Unexpected mocked bridge method: ${String(name)}`)
    return api[String(name)](...args)
  }
} })

function Harness() {
  const [config, setConfig] = useState<{ id: number; initial: ShotMaterialSelection[] }>({ id: 1, initial: [] })
  fixture.setConfig = setConfig
  fixture.mounted = config.id
  return <ShotMaterialPickerDialog key={config.id} open initialSelections={config.initial}
    shotTitle="隔离验证：scara 范围（模拟素材）" onClose={() => undefined}
    onConfirm={selections => fixture.confirms.push({ selections, bindings: selectionsToMaterialBindings(selections) })} />
}
createRoot(document.getElementById('root')!).render(<Harness />)

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
  fixture.checks.push(message)
}
const pause = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => unknown, label: string) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Fixture wait timed out: ${label}; page=${document.body.innerText}`)
    await pause(20)
  }
}
function aria(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label)
  if (!element) throw new Error(`Button absent: ${label}`)
  return element
}
function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
  if (!element) throw new Error(`Button absent: ${label}`)
  return element
}
function confirm() { return document.querySelector<HTMLButtonElement>('.shot-picker-footer .primary')! }
function status() { return document.querySelector('.shot-picker-selection-summary [role="status"]')?.textContent || '' }
async function count(expected: number) {
  await until(() => status().includes(`合并去重后 ${expected} 个候选视频`), `candidate count ${expected}`)
}
async function openFolder(name: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('.shot-picker-folder-main')].find(item => item.querySelector('strong')?.textContent === name)
  if (!element) throw new Error(`Folder card absent: ${name}`)
  element.click()
  await until(() => document.querySelector('.shot-picker-result-head nav')?.textContent?.endsWith(name), `open ${name}`)
  await pause(40)
}
async function mount(initial: ShotMaterialSelection[] = []) {
  const id = fixture.mounted + 1
  fixture.setConfig({ id, initial })
  await until(() => fixture.mounted === id && document.querySelector('.shot-picker-folder-main strong')?.textContent === 'scara', 'fresh picker')
  await pause(40)
}
function snapshot(name: string) {
  fixture.snapshots.push({ name, status: status(), text: document.body.innerText, confirmationDisabled: confirm().disabled })
}

fixture.run = async () => {
  await until(() => fixture.mounted && document.querySelector('.shot-picker-folder-main'), 'initial picker')
  const navigationFolders = Array.from({ length: 30 }, (_, index) => ({ id: `fld_nav_${index}`, name: `导航文件夹 ${index + 1}`, kind: 'user' as const, videoCount: 0 }))
  listings.library.folders.push(...navigationFolders)
  for (const folder of navigationFolders) listings[folder.id] = { current: folder, breadcrumbs: [library, folder], folders: [], files: [] }
  await mount()
  const tree = document.querySelector<HTMLElement>('[aria-label="素材文件夹导航"]')!
  check(tree.querySelectorAll('button').length === 32, '左侧导航完整渲染全部 31 个目录及根目录，第 11 项后不再被截掉')
  check(tree.scrollHeight > tree.clientHeight, '大量文件夹时左侧导航形成独立滚动区域')
  const lastFolder = [...tree.querySelectorAll<HTMLButtonElement>('button')].at(-1)!
  lastFolder.focus()
  lastFolder.scrollIntoView({ block: 'nearest' })
  const bounds = lastFolder.getBoundingClientRect()
  const treeBounds = tree.getBoundingClientRect()
  check(bounds.top >= treeBounds.top && bounds.bottom <= treeBounds.bottom, '最后一个文件夹可滚动到可见区域并获得键盘焦点')
  lastFolder.click()
  await until(() => document.querySelector('.shot-picker-result-head nav')?.textContent?.endsWith('导航文件夹 30'), 'open last sidebar folder')
  check(fixture.calls.some((call: any) => call.name === 'browseMaterials' && call.args[0]?.folderId === 'fld_nav_29'), '点击第 30 个文件夹会打开对应素材范围')
  listings.library.folders.splice(1)
  await mount()
  aria('选择文件夹 scara').click()
  await until(() => document.querySelector('[aria-label="scara 包含子文件夹"]'), 'new folder selected')
  check(aria('scara 包含子文件夹').getAttribute('aria-pressed') === 'true', '新选 scara 默认包含全部子文件夹')
  await count(21)
  check(document.querySelector('.shot-picker-folder-main')?.textContent?.includes('21 个视频'), '选中文件夹卡片数量与真实范围摘要的 21 个候选一致')
  check(!confirm().disabled, '21 个候选时允许确认')
  snapshot('default-descendants-21')

  aria('scara 包含子文件夹').click()
  await count(0)
  check(aria('scara 包含子文件夹').getAttribute('aria-pressed') === 'false', '关闭子文件夹后按钮为未选状态')
  check(confirm().disabled, 'scara 直接视频为零时阻止确认')
  check(document.querySelector('.shot-picker-footer')?.textContent?.includes('所选范围没有视频'), '空范围明确提示包含子文件夹或重新选择')
  const beforeEmptyConfirm = fixture.confirms.length
  confirm().click()
  await pause(40)
  check(fixture.confirms.length === beforeEmptyConfirm, '点击空范围的禁用确认按钮不会提交')
  snapshot('direct-only-empty')

  aria('scara 包含子文件夹').click()
  await count(21)
  check(!confirm().disabled, '重新包含子文件夹恢复 21 个候选并允许确认')
  await openFolder('scara')
  check(document.querySelector('.shot-picker-current-actions')?.textContent?.includes('2 个文件夹 · 0 个视频'), 'scara 当前目录显示直接视频 0，与子树范围数量分开')
  aria('选择文件夹 child14').click()
  await count(21)
  await openFolder('child14')
  aria('选择素材 scara-01.mp4').click()
  await count(21)
  check(status().includes('1 个视频 · 2 个文件夹'), '父目录、14 个视频子目录和重复单文件均已选')
  check(!status().includes('36 个候选视频'), '父子目录及单文件重叠按候选身份去重为 21，未相加为 36')
  confirm().click()
  await until(() => fixture.confirms.length === 1, 'confirm parent child file')
  check(fixture.confirms[0].bindings.filter((binding: ShotMaterialBinding) => binding.binding_type === 'folder').every((binding: any) => binding.include_subfolders === true), '确认提交的父子文件夹绑定均保存 include_subfolders: true')
  check(fixture.confirms[0].bindings.some((binding: any) => binding.material_id === 'mat_1'), '确认提交保留显式单文件绑定')
  snapshot('parent-child-file-unique-21')

  let finishDetails: ((folder: MaterialFolderNode) => void) | undefined
  detailBehavior = () => new Promise(resolve => { finishDetails = resolve })
  await mount(materialBindingsToSelections([{ binding_type: 'folder', folder_id: scara.id, include_subfolders: false }]))
  await until(() => finishDetails, 'delayed legacy folder hydration started')
  await count(0)
  check(aria('fld_scara 包含子文件夹').getAttribute('aria-pressed') === 'false', '恢复旧绑定时保留明确的 include_subfolders: false')
  finishDetails!(scara)
  await until(() => document.querySelector('[aria-label="scara 包含子文件夹"]'), 'legacy folder detail hydrated')
  await pause()
  check(aria('scara 包含子文件夹').getAttribute('aria-pressed') === 'false' && status().includes('合并去重后 0'), '异步文件夹详情补全名称后仍保留旧绑定 false 与 0 候选')
  snapshot('legacy-false-after-hydration')
  detailBehavior = undefined

  let finishOldSummary: (() => void) | undefined
  let holdNextRecursive = true
  summaryBehavior = async bindings => {
    if (holdNextRecursive && bindings.some(binding => binding.binding_type === 'folder' && binding.include_subfolders)) {
      holdNextRecursive = false
      return new Promise(resolve => { finishOldSummary = () => resolve(summaryFor(bindings)) })
    }
    return summaryFor(bindings)
  }
  await mount()
  aria('选择文件夹 scara').click()
  await until(() => finishOldSummary, 'old recursive count is pending')
  check(status().includes('正在统计范围') && confirm().disabled, '异步统计未完成时显示统计中并阻止确认')
  aria('scara 包含子文件夹').click()
  await count(0)
  finishOldSummary!()
  await pause(300)
  check(status().includes('合并去重后 0 个候选视频') && confirm().disabled, '迟到的旧 21 候选响应不会覆盖当前直接范围的 0 候选')
  snapshot('late-response-stays-zero')
  summaryBehavior = undefined

  await mount()
  let failNext = true
  summaryBehavior = async bindings => {
    if (bindings.length && failNext) { failNext = false; throw new Error('Expected isolated summary outage') }
    return summaryFor(bindings)
  }
  aria('选择文件夹 scara').click()
  await until(() => status().includes('范围统计失败'), 'summary error shown')
  check(confirm().disabled, '范围摘要失败时禁用确认')
  check(!status().includes('合并去重后 0 个候选视频') && !document.querySelector('.shot-picker-selection-list')?.textContent?.includes('0 个候选视频'), '范围摘要失败不会伪装成 0 个候选')
  check(Boolean(button('重新统计')), '范围统计失败有清晰的重新统计入口')
  snapshot('summary-failure-retry')
  button('重新统计').click()
  await count(21)
  check(!confirm().disabled && !status().includes('范围统计失败'), '重新统计恢复真实的 21 候选并清除错误')
  summaryBehavior = undefined

  await mount()
  await openFolder('scara')
  button('选择当前目录').click()
  await count(21)
  check(aria('scara 包含子文件夹').getAttribute('aria-pressed') === 'true', '通过选择当前目录入口新建的文件夹范围同样默认包含子文件夹')
  check(fixture.errors.length === 0, '真实 React 选择器隔离运行无未处理异常')
  snapshot('current-directory-default-21')
  return { ok: true, scope: 'isolated real React picker/model with mocked bridge/library; no user database, external network, model, real video, native mouse or focus', checks: fixture.checks, snapshots: fixture.snapshots, confirms: fixture.confirms, calls: fixture.calls }
}
