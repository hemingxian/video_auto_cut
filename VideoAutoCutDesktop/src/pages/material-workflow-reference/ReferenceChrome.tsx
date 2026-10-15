import {
  Boxes,
  CircleUserRound,
  History,
  Mic2,
  Play,
  Settings,
} from 'lucide-react'

import appIcon from '../../assets/app-icon.png'

export function ReferenceSidebar({ active = 'materials' }: { active?: 'start' | 'materials' }) {
  return <aside className="vac-ref-sidebar" aria-label="应用导航">
    <img className="vac-ref-brand" src={appIcon} alt="" />
    <nav>
      <button className={active === 'start' ? 'active' : undefined} type="button" aria-label="开始任务">
        <Play />
      </button>
      <button type="button" aria-label="历史任务"><History /></button>
      <button className={active === 'materials' ? 'active' : undefined} type="button" aria-label="素材库">
        <Boxes />
      </button>
      <button type="button" aria-label="音色克隆"><Mic2 /></button>
    </nav>
    <div className="vac-ref-sidebar-bottom">
      <button type="button" aria-label="账号"><CircleUserRound /></button>
      <button type="button" aria-label="设置"><Settings /></button>
    </div>
  </aside>
}

export function ReferenceBackdrop() {
  return <div className="vac-ref-backdrop" aria-hidden="true">
    <ReferenceSidebar active="start" />
    <main>
      <div className="vac-ref-backdrop-head">
        <div />
        <div />
      </div>
      <div className="vac-ref-backdrop-grid">
        <section />
        <section />
      </div>
    </main>
  </div>
}
