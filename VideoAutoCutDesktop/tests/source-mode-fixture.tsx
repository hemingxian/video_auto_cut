// ISOLATED FIXTURE: real React page/controller/resolver, all bridge/storage/search results are mocks.
// No real user files, model API, Pexels request, engine invocation or video is used.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StartPage } from '../src/pages/StartPage'
import { useStartTaskController } from '../src/pages/start/useStartTaskController'
import { resolveAutomaticShotMaterials } from '../electron/material-auto-reuse'
import '../src/style.css'

const fixture: any = { task: null, calls: [], checks: [], ready: false, errors: [] }
;(window as any).sourceModeFixture = fixture
window.addEventListener('error', (event) => fixture.errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => fixture.errors.push(String(event.reason)))
const plan = {
  schema_version: 2, topic: '隔离测试：素材来源模式', material_source_mode: 'library-only',
  shots: [{ shot_id: 'shot_fixture_missing', title: '未命中的机械臂', visual_query: 'robot arm',
    download_material: true, material_bindings: [], duration: 6 }],
}
const run: any = { id: 'run_fixture', projectName: '隔离测试', path: 'X:/mock/run_fixture', mtime: 1,
  shotsPath: 'X:/mock/run_fixture/shots.json', logPath: '', finalVideo: '', artifacts: [] }
const files = new Map([[run.shotsPath, JSON.stringify(plan)]])
files.set(`${run.path}/material-source-mode.json`, JSON.stringify({ material_source_mode: 'library-first' }))
let revision = 3
const api: Record<string, (...args: any[]) => any> = {
  taskStatus: async () => ({ running: false }),
  onTaskEvent: () => () => undefined,
  onMaterialLibraryEvent: () => () => undefined,
  chooseScriptFiles: async () => ['X:/mock/中文脚本一.xlsx', 'X:/mock/中文脚本二.xlsx'],
  listRuns: async () => [run],
  loadTaskDraft: async () => ({ revision, snapshot: plan, updatedAt: new Date().toISOString() }),
  saveTaskDraft: async ({ snapshot }) => ({ revision: ++revision, snapshot, updatedAt: new Date().toISOString() }),
  readFile: async (name) => { if (files.has(name)) return files.get(name); throw new Error('Fixture file absent') },
  writeFile: async (name, value) => { files.set(name, value); return { ok: true } },
  autoResolveShotMaterials: async (options) => resolveAutomaticShotMaterials(options, async () => ({ ok: true, results: [] })),
  prepareGenerationManifest: async () => { throw new Error('Unexpected manifest preparation: test must block earlier') },
  startTask: async () => { throw new Error('Unexpected engine request: test must block earlier') },
}
;(window as any).videoAutoCut = new Proxy({}, { get(_target, name) {
  return (...args: any[]) => {
    fixture.calls.push({ name: String(name), args })
    if (!api[String(name)]) throw new Error(`Unexpected mocked bridge method: ${String(name)}`)
    return api[String(name)](...args)
  }
} })

function Harness() {
  const task = useStartTaskController()
  const [disabled, setDisabled] = useState(false)
  const [capture, setCapture] = useState(false)
  fixture.task = task
  fixture.setDisabled = setDisabled
  fixture.setCapture = setCapture
  fixture.ready = true
  return <div className="app-shell"><aside className="sidebar" aria-label="模拟侧栏" />
    <main className="main-area"><StartPage task={{ ...task, toast: capture ? '' : task.toast, materialStrategyDisabled: disabled || task.materialStrategyDisabled }} /></main>
  </div>
}
createRoot(document.getElementById('root')!).render(<Harness />)

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
  fixture.checks.push(message)
}
const settle = () => new Promise(resolve => setTimeout(resolve, 220))
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 4000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Fixture state wait timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
  if (!element) throw new Error(`Button absent: ${label}`)
  return element
}
function selector() {
  return document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="素材来源模式"]')!
}
const modeLabels: Record<string, string> = { 'library-only': '仅素材库', 'library-first': '素材库 → Pexels', 'pexels-only': '仅 Pexels' }
function key(element: Element, value: string) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}
async function openModes() {
  selector().focus()
  key(selector(), 'ArrowDown')
  await until(() => document.querySelectorAll('[role="option"]').length === 3)
  await settle()
}
async function closeModes() {
  key(document.activeElement!, 'Escape')
  await until(() => !document.querySelector('[role="listbox"]'))
  await settle()
}
async function mode(value: string) {
  await openModes()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes(modeLabels[value]))!
  option.focus()
  key(option, 'Enter')
  await until(() => fixture.task.materialSourceMode === value)
  await until(() => !document.querySelector('[role="listbox"]'))
  await settle()
}
async function closeScriptDialog() {
  document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')!.click()
  await settle()
}

fixture.run = async () => {
  await until(() => fixture.ready)
  await settle()
  check(Boolean(selector()), '真实工作台显示素材来源选择器')
  check(selector().textContent?.includes('素材库 → Pexels'), '初始模式为素材库优先')
  await openModes()
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
  check(Object.values(modeLabels).every((label, index) => options[index].textContent?.includes(label)), '选择器完整提供三种模式')
  check(options.filter(item => item.getAttribute('data-state') === 'checked').length === 1, '三种模式只有当前选项标记为选中')
  check(Boolean(document.activeElement?.closest('[role="option"]')), '键盘展开后焦点进入选项')
  await closeModes()
  check(document.activeElement === selector(), 'Escape 关闭后焦点回到触发按钮')
  selector().dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerType: 'mouse', bubbles: true, cancelable: true }))
  await until(() => document.querySelectorAll('[role="option"]').length === 3)
  await settle()
  const pointerOption = document.querySelector<HTMLElement>('[role="option"]')!
  pointerOption.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', bubbles: true }))
  pointerOption.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', bubbles: true }))
  await until(() => fixture.task.materialSourceMode === 'library-only')
  await settle()
  check(selector().textContent?.includes('仅素材库'), '页面指针事件可选择模式并更新按钮文案')
  await mode('library-first')
  fixture.setDisabled(true)
  await settle()
  check(selector().disabled, '运行锁定状态禁用模式按钮')
  selector().click()
  await settle()
  check(!document.querySelector('[role="listbox"]'), '禁用状态点击不会打开模式菜单')
  fixture.setDisabled(false)
  await settle()
  button('脚本文件').click()
  await settle()
  button('选择脚本').click()
  await until(() => document.querySelectorAll('.script-file-row').length === 2)
  check(!button('统一设置素材范围').disabled, '素材库模式允许统一绑定范围')
  check([...document.querySelectorAll<HTMLButtonElement>('.script-file-bind')].every(item => !item.disabled), '素材库模式允许逐脚本绑定范围')

  await closeScriptDialog()
  await mode('pexels-only')
  button('脚本文件').click()
  await settle()
  check(button('统一设置素材范围').disabled, '仅 Pexels 禁用统一设置素材范围')
  check([...document.querySelectorAll<HTMLButtonElement>('.script-file-bind')].every(item => item.disabled), '仅 Pexels 禁用全部逐脚本绑定按钮')
  button('统一设置素材范围').click()
  document.querySelector<HTMLButtonElement>('.script-file-bind')!.click()
  await settle()
  check(document.querySelectorAll('[role="dialog"]').length === 1, '点击禁用按钮不会打开素材绑定弹窗')
  fixture.task.updateScriptMaterials('X:/mock/中文脚本一.xlsx', [{ id: 'mat_fixture', kind: 'file', name: '模拟素材.mp4' }])
  await settle()
  check(Object.keys(fixture.task.scriptMaterialSelections).length === 0, '控制器同时拒绝绕过按钮的脚本绑定调用')

  await closeScriptDialog()
  await mode('library-only')
  button('脚本文件').click()
  await settle()
  check(!button('统一设置素材范围').disabled && [...document.querySelectorAll<HTMLButtonElement>('.script-file-bind')].every(item => !item.disabled), '切回仅素材库后恢复统一与单独绑定入口')
  await closeScriptDialog()
  check(await fixture.task.restoreRun(run), '真实控制器成功恢复模拟分镜任务')
  await until(() => fixture.task.shots.length === 1)
  check(fixture.task.materialSourceMode === 'library-only', '恢复任务时新草稿的仅素材库模式优先于旧附属文件的素材库优先模式')
  const before = fixture.calls.length
  await fixture.task.generateVideo()
  await settle()
  const generationCalls = fixture.calls.slice(before)
  check(generationCalls.some((call: any) => call.name === 'autoResolveShotMaterials' && call.args[0].materialSourceMode === 'library-only'), '生成动作将仅素材库模式传到真实解析器')
  check(!generationCalls.some((call: any) => call.name === 'prepareGenerationManifest'), '素材库未命中时不准备生成清单')
  check(!generationCalls.some((call: any) => call.name === 'startTask'), '素材库未命中时不启动生成引擎')
  check(fixture.task.shots[0].download_material === false, '未命中分镜保持禁止外部下载')
  check(fixture.task.toast.includes('未命中的机械臂') && fixture.task.toast.includes('不能从 Pexels 下载'), '页面反馈包含具体分镜及禁止下载原因')
  check(fixture.errors.length === 0, '隔离页面没有未处理异常')
  return { ok: true, scope: 'isolated frontend test with real React/controller/resolver and mocked bridge/search/storage; no real API, video or mouse input', checks: fixture.checks, calls: fixture.calls.map((item: any) => item.name) }
}

fixture.captureMenu = async () => {
  fixture.task.setShotDrawerOpen(false)
  fixture.setCapture(true)
  await settle()
  await mode('library-first')
  await openModes()
  document.querySelector<HTMLElement>('[role="option"][data-state="checked"]')!.focus()
  await settle()
  const bounds = (element: Element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
  }
  const menu = document.querySelector('[role="listbox"]')!
  const menuRect = bounds(menu)
  const triggerRect = bounds(selector())
  const toolbar = document.querySelector('.page-action')!
  const controls = [...toolbar.querySelectorAll<HTMLElement>('button')].filter(item => item.offsetWidth).map(item => ({ text: item.textContent, ...bounds(item) }))
  check(menuRect.x >= 0 && menuRect.right <= innerWidth && menuRect.y >= 0 && menuRect.bottom <= innerHeight, `${innerWidth}px 菜单完整位于窗口内`)
  check(controls.every(item => item.x >= 0 && item.right <= innerWidth), `${innerWidth}px 工具栏全部按钮可见`)
  const overlaps = controls.flatMap((item, index) => controls.slice(index + 1).filter(other => item.x < other.right && other.x < item.right && item.y < other.bottom && other.y < item.bottom))
  check(overlaps.length === 0, `${innerWidth}px 工具栏按钮互不覆盖`)
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(item => ({ text: item.textContent, selected: item.getAttribute('data-state'), highlighted: item.hasAttribute('data-highlighted'), background: getComputedStyle(item).backgroundColor }))
  return { viewport: { width: innerWidth, height: innerHeight }, menu: menuRect, trigger: triggerRect, controls, options }
}
fixture.closeModes = closeModes
