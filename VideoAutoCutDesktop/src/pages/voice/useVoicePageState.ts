import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAsyncRefresh } from '../../hooks/useAsyncRefresh'
import type { EnvMap, FileItem, VoiceRegistryItem } from '../../types/videoauto'

interface VoiceLibraryState {
  env: EnvMap
  registryItems: VoiceRegistryItem[]
  templateItems: FileItem[]
}

function normalizeVoicePrefix(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, '')
}

export function useVoicePageState() {
  const [file, setFile] = useState('')
  const [prefix, setPrefix] = useState('myvoice')
  const [templates, setTemplates] = useState<FileItem[]>([])
  const [voices, setVoices] = useState<VoiceRegistryItem[]>([])
  const [currentVoiceId, setCurrentVoiceId] = useState('')
  const [message, setMessage] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [logOpen, setLogOpen] = useState(false)

  const selectedTemplate = useMemo(() => templates.find((item) => item.path === file) || null, [file, templates])

  const loadTemplates = useCallback(async (): Promise<VoiceLibraryState> => {
    const [templateItems, registryItems, env] = await Promise.all([
      window.videoAutoCut.listVoiceTemplates(),
      window.videoAutoCut.listVoiceRegistry(),
      window.videoAutoCut.readEnv(),
    ])

    return { env, registryItems, templateItems }
  }, [])

  const applyTemplates = useCallback(({ env, registryItems, templateItems }: VoiceLibraryState) => {
    setTemplates(templateItems)
    setVoices(registryItems)
    setCurrentVoiceId(env.DASHSCOPE_TTS_VOICE_TEMPLATE || '')
    setFile((current) => {
      if (current && templateItems.some((item) => item.path === current)) return current
      return templateItems[0]?.path || ''
    })
  }, [])
  const { refresh: refreshTemplates } = useAsyncRefresh({
    load: loadTemplates,
    apply: applyTemplates,
  })

  const importTemplates = useCallback(async () => {
    const imported = await window.videoAutoCut.importVoiceTemplates()
    if (imported[0]) setFile(imported[0].path)
    await refreshTemplates()
  }, [refreshTemplates])

  const createVoice = useCallback(async () => {
    if (!file) {
      setMessage('请先添加并选择一个声音模板')
      return
    }

    setMessage('正在创建音色...')
    setLogs((items) => items.concat('开始创建音色...\n'))
    await window.videoAutoCut.cloneVoice({ file, prefix: prefix.trim() || 'myvoice' })
  }, [file, prefix])

  const applyVoice = useCallback(async (voiceId: string) => {
    const env = await window.videoAutoCut.readEnv()
    await window.videoAutoCut.writeEnv({ ...env, DASHSCOPE_TTS_VOICE_TEMPLATE: voiceId })
    setCurrentVoiceId(voiceId)
    setMessage('已设为当前音色')
  }, [])

  useEffect(() => {
    const dispose = window.videoAutoCut.onVoiceEvent((event) => {
      if (event.type === 'start') {
        setMessage('正在创建音色...')
        setLogs((items) => items.concat('>>> ' + (event.command || '创建音色') + '\n'))
      }

      if (event.text) setLogs((items) => items.concat(event.text || ''))

      if (event.type === 'close') {
        setMessage(event.code === 0 ? '音色创建完成' : `音色创建失败，退出码：${event.code}`)
        setLogs((items) => items.concat(`\n音色克隆结束，退出码：${event.code}\n`))
        refreshTemplates().catch(() => undefined)
      }
    })

    return () => {
      dispose()
    }
  }, [refreshTemplates])

  return {
    createVoice,
    currentVoiceId,
    file,
    importTemplates,
    logOpen,
    logs,
    message,
    prefix,
    refreshTemplates,
    selectedTemplate,
    setFile,
    setLogOpen,
    setPrefix: (value: string) => setPrefix(normalizeVoicePrefix(value)),
    templates,
    voices,
    applyVoice,
  }
}
