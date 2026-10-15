import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VisualStylePanel } from '../src/pages/config/VisualStylePanel'
import type { ConfigValues } from '../src/types/videoauto'
import '../src/style.css'

window.videoAutoCut = { readProgressTemplates: async () => [] } as unknown as typeof window.videoAutoCut
function Review() {
  const [values, setValues] = useState<ConfigValues>({})
  return <div style={{ padding: 32 }}>
    <VisualStylePanel values={values} onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />
    <output aria-label="保存的设置">{JSON.stringify(values)}</output>
  </div>
}
createRoot(document.getElementById('root')!).render(<Review />)
