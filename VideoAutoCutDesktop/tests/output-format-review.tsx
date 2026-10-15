import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScriptFilesDialog } from '../src/pages/start/ScriptFilesDialog'
import { normalizeOutputResolution } from '../src/pages/start/outputFormatModel'
import { createScriptQueueItems, queueItemOptions } from '../src/pages/start/taskQueueModel'
import '../src/style.css'

function Review() {
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [outputResolution, setOutputResolution] = useState('1080p')
  const [saved, setSaved] = useState('')
  const save = () => setSaved(JSON.stringify(queueItemOptions(createScriptQueueItems({
    paths: ['C:/fixture/示例脚本.xlsx'], mode: 'plan', source: 'pexels', materialMode: 'download', aspectRatio, outputResolution,
  })[0])))
  return <>
    <output aria-label="冻结后的任务选项">{saved}</output>
    <ScriptFilesDialog open scripts="C:/fixture/示例脚本.xlsx" aspectRatio={aspectRatio} outputResolution={outputResolution}
      onAspectRatioChange={(value) => { setAspectRatio(value); setOutputResolution((current) => normalizeOutputResolution(value, current)) }}
      onOutputResolutionChange={setOutputResolution} materialSelections={{}} allowMaterialBindings={false}
      onMaterialsChange={() => {}} onClose={() => {}} onChooseScripts={() => {}} onScriptsChange={() => {}}
      onImportAndPlan={save} onImportAndGenerate={save} />
  </>
}
createRoot(document.getElementById('root')!).render(<Review />)
