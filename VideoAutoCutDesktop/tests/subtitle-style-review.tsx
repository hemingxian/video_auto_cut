import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VisualStylePanel } from '../src/pages/config/VisualStylePanel'
import '../src/style.css'

window.videoAutoCut = { readProgressTemplates: async () => [], writeProgressTemplates: async (items: any) => items } as any
function Review() {
  const [values, setValues] = useState<Record<string, any>>({ SUBTITLE_FONT: 'Microsoft YaHei', SUBTITLE_FONT_SIZE: '68', SUBTITLE_Y: '620', PROGRESS_BAR: true })
  return <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}><h1>字幕样式本地核对</h1><VisualStylePanel values={values} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} /></div>
}
createRoot(document.getElementById('root')!).render(<Review />)
