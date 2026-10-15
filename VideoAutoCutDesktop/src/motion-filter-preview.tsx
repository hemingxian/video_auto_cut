import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { motion } from 'framer-motion'
import * as ToggleGroup from 'radix-ui/toggle-group'

import './styles/motion-filter-preview.css'

type FilterValue = 'all' | 'local' | 'cloud' | 'sync_failed' | 'unanalyzed'

const filters: Array<{
  value: FilterValue
  label: string
  badge?: number
  tone?: 'danger' | 'warning'
}> = [
  { value: 'all', label: '全部' },
  { value: 'local', label: '本地' },
  { value: 'cloud', label: '云端' },
  { value: 'sync_failed', label: '同步失败', badge: 2, tone: 'danger' },
  { value: 'unanalyzed', label: '未分析', badge: 12, tone: 'warning' },
]

interface MaterialFilterProps {
  value: FilterValue
  onValueChange?: (value: FilterValue) => void
  interactive?: boolean
  layoutId?: string
  slowMotion?: boolean
}

function MaterialFilter({
  value,
  onValueChange,
  interactive = true,
  layoutId = 'material-filter-active',
  slowMotion = false,
}: MaterialFilterProps) {
  return <ToggleGroup.Root
    aria-label="素材位置与处理状态筛选"
    className="motion-filter"
    type="single"
    value={value}
    onValueChange={(nextValue) => {
      if (interactive && nextValue) onValueChange?.(nextValue as FilterValue)
    }}
  >
    {filters.map((filter) => {
      const active = value === filter.value
      return <ToggleGroup.Item
        className="motion-filter__item"
        data-tone={filter.tone}
        key={filter.value}
        tabIndex={interactive ? undefined : -1}
        value={filter.value}
      >
        {active && <motion.span
          className="motion-filter__indicator"
          layoutId={layoutId}
          transition={slowMotion
            ? { duration: 1.4, ease: [0.22, 1, 0.36, 1] }
            : { type: 'spring', stiffness: 480, damping: 38, mass: 0.72 }}
        />}
        <span className="motion-filter__label">{filter.label}</span>
        {filter.badge !== undefined && <span className="motion-filter__badge">
          {filter.badge}
        </span>}
      </ToggleGroup.Item>
    })}
  </ToggleGroup.Root>
}

function App() {
  const [activeFilter, setActiveFilter] = useState<FilterValue>('all')
  const [autoPlay, setAutoPlay] = useState(true)

  useEffect(() => {
    if (!autoPlay) return undefined
    const timer = window.setInterval(() => {
      setActiveFilter((current) => {
        const index = filters.findIndex((filter) => filter.value === current)
        return filters[(index + 1) % filters.length].value
      })
    }, 1800)
    return () => window.clearInterval(timer)
  }, [autoPlay])

  return <main className="preview-page">
    <div className="preview-glow preview-glow--blue" />
    <div className="preview-glow preview-glow--violet" />

    <section className="preview-shell">
      <header className="preview-header">
        <div>
          <span className="preview-eyebrow">MATERIAL LIBRARY · FILTER</span>
          <h1>素材库状态筛选器</h1>
          <p>Radix Toggle Group 保留交互语义，Motion Layout Animation 负责选中底板的连续移动。</p>
        </div>
        <div className="preview-status">
          <span className="preview-status__dot" />
          Motion 实时演示
        </div>
      </header>

      <div className="live-card">
        <div className="live-card__heading">
          <div>
            <strong>实际交互效果</strong>
            <span>点击任意状态，观察蓝色底板滑动</span>
          </div>
          <button type="button" onClick={() => setAutoPlay((value) => !value)}>
            {autoPlay ? '暂停自动演示' : '继续自动演示'}
          </button>
        </div>
        <div className="live-stage">
          <MaterialFilter
            value={activeFilter}
            slowMotion
            onValueChange={(value) => {
              setAutoPlay(false)
              setActiveFilter(value)
            }}
          />
        </div>
        <div className="live-card__notes">
          <span><i className="note-dot note-dot--blue" />共享底板平滑移动</span>
          <span><i className="note-dot note-dot--red" />失败状态保留红色提示</span>
          <span><i className="note-dot note-dot--amber" />未分析使用橙色提示</span>
        </div>
      </div>

      <div className="frames-title">
        <strong>三个关键帧</strong>
        <span>实际切换时，底板会沿箭头方向连续滑动，而不是瞬间换色</span>
      </div>

      <div className="frames-grid">
        <article className="frame-card">
          <span className="frame-card__index">01</span>
          <div className="frame-card__label">初始位置 · 全部</div>
          <MaterialFilter value="all" interactive={false} layoutId="frame-all" />
        </article>
        <div className="frame-arrow" aria-hidden="true">→</div>
        <article className="frame-card">
          <span className="frame-card__index">02</span>
          <div className="frame-card__label">中间位置 · 云端</div>
          <MaterialFilter value="cloud" interactive={false} layoutId="frame-cloud" />
        </article>
        <div className="frame-arrow" aria-hidden="true">→</div>
        <article className="frame-card">
          <span className="frame-card__index">03</span>
          <div className="frame-card__label">异常筛选 · 同步失败</div>
          <MaterialFilter value="sync_failed" interactive={false} layoutId="frame-error" />
        </article>
      </div>
    </section>
  </main>
}

const previewRoot = createRoot(document.getElementById('root')!)
previewRoot.render(<StrictMode><App /></StrictMode>)

if (import.meta.hot) {
  import.meta.hot.dispose(() => previewRoot.unmount())
}
