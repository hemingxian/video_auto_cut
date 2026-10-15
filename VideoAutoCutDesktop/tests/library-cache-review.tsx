import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useMaterialsLibrary } from '../src/pages/materials/useMaterialsLibrary'
import { emptyLibrary } from '../src/pages/materials/constants'
import { createMaterialDirectoryCache } from '../src/pages/materials/materialDirectoryCache'
import type { MaterialDirectoryListing } from '../src/types/videoauto'

const fixture: any = { checks: [], browseCalls: [], errors: [] }
;(window as any).libraryCacheFixture = fixture
window.addEventListener('error', event => fixture.errors.push(event.message))
window.addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)))
const listing = (id: string): MaterialDirectoryListing => ({ current: { id, name: id, kind: null }, breadcrumbs: [], files: [], folders: [] })
const root = listing('root')
let listener: any = () => {}
let resolveHeld: ((value: MaterialDirectoryListing) => void) | undefined
let holdId = ''
;(window as any).videoAutoCut = {
  browseMaterials: async (options: any) => {
    const id = options?.folderId || 'root'
    fixture.browseCalls.push(id)
    if (id === holdId) return new Promise<MaterialDirectoryListing>(resolve => { resolveHeld = resolve })
    return id === 'root' ? root : listing(id)
  },
  listMaterials: async () => emptyLibrary,
  materialCloudStatus: async () => ({ configured: false, authenticated: false }),
  readEnv: async () => ({}),
  onMaterialLibraryEvent: (callback: any) => { listener = callback; return () => {} },
}
function Harness() {
  const state = useMaterialsLibrary()
  fixture.state = state
  return <div>{['A','B','C'].map(id => <button key={id} onClick={() => state.openFolder(id)}>{id}</button>)}<pre>{JSON.stringify({ folder: state.listing?.current.id, loading: state.loading })}</pre></div>
}
function Host() {
  const [id, setId] = useState(0)
  fixture.remount = () => setId(id + 1)
  return <Harness key={id} />
}
createRoot(document.getElementById('root')!).render(<Host />)
const pause = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(test: () => unknown) {
  const deadline = performance.now() + 4000
  while (!test()) { if (performance.now() > deadline) throw new Error('fixture timed out'); await pause() }
}
function check(value: unknown, message: string) { if (!value) throw new Error(message); fixture.checks.push(message) }
function open(id: string) { [...document.querySelectorAll('button')].find(button => button.textContent === id)!.click() }
fixture.run = async () => {
  await until(() => fixture.state?.listing?.current.id === 'root')
  open('A'); await until(() => fixture.state.listing?.current.id === 'A' && !fixture.state.loading)
  open('B'); await until(() => fixture.state.listing?.current.id === 'B' && !fixture.state.loading)
  holdId = 'A'
  const began = performance.now()
  open('A'); await until(() => fixture.state.listing?.current.id === 'A' && resolveHeld)
  fixture.cachedNavigationMs = performance.now() - began
  check(fixture.state.loading, '再次打开目录时立即显示缓存，同时请求仍在后台等待')
  check(fixture.browseCalls.filter((id: string) => id === 'A').length === 2, '显示缓存仍发起权威刷新，没有永久跳过变化')
  resolveHeld!(listing('A')); holdId = ''; resolveHeld = undefined
  await until(() => !fixture.state.loading)
  listener({ type: 'analysis-status', status: 'ready' })
  holdId = 'B'; open('B')
  await until(() => resolveHeld)
  check(fixture.state.listing === null, '素材变化事件清除旧目录缓存，不展示过期B目录')
  resolveHeld!(listing('B')); holdId = ''; resolveHeld = undefined
  await until(() => fixture.state.listing?.current.id === 'B')
  fixture.remount(); await until(() => fixture.state.listing?.current.id === 'root')
  holdId = 'A'; open('A'); await until(() => resolveHeld)
  check(fixture.state.listing === null, '重新挂载后没有前一次账号会话的目录缓存')
  resolveHeld!(listing('A')); holdId = ''
  const cache = createMaterialDirectoryCache(2)
  cache.set(listing('A')); cache.set(listing('B')); cache.get('A'); cache.set(listing('C'))
  check(cache.get('B') === null && cache.get('A')?.current.id === 'A', '导航缓存按最近使用淘汰，限制内存占用')
  check(fixture.errors.length === 0, '真实React hook界面无未处理异常')
  return { ok: true, checks: fixture.checks, cachedNavigationMs: fixture.cachedNavigationMs,
    scope: 'real React hook; simulated local bridge latency; no live cloud/db/mouse' }
}
