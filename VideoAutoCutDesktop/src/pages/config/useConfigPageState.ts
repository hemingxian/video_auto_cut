import { useEffect, useMemo, useRef, useState } from 'react'

import { configGroups } from '../../config/settings'
import { useAsyncRefresh } from '../../hooks/useAsyncRefresh'
import { useTimedFlag } from '../../hooks/useTimedFlag'
import type { AppInfo, ConfigSpec, ConfigValue } from '../../types/app'
import type { EnvMap } from '../../types/videoauto'

interface ConfigPageData {
  env: EnvMap
}

type ConfigValues = Record<string, ConfigValue>

const SWITCH_CONFIG_KEYS = new Set(
  configGroups.flatMap((group) => group.items.filter((item) => item.type === 'switch').map((item) => item.key)),
)

// 与 VideoAutoCut/tools/common.py 的 parse_bool 同一口径：大小写不敏感、认同一批词。
// 以前只认精确的 'true'，于是手写成 1 / yes / TRUE 的键在设置页显示成「关闭」，
// 用户改别的设置触发整表回写时会把它**静默写成 false**，功能被悄悄关掉。
const SWITCH_TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on'])
const SWITCH_FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off'])
// 认不出来（缺键、空值、乱写）时用这个键自己的默认值，必须与 Python 侧的默认保持一致。
const SWITCH_DEFAULT_ON = new Set(['VIDEOAUTO_PACKAGING_SCRIPT_ONLY'])

function switchValue(raw: string | undefined, key: string): boolean {
  const text = String(raw ?? '').trim().toLowerCase()
  if (SWITCH_TRUE_VALUES.has(text)) return true
  if (SWITCH_FALSE_VALUES.has(text)) return false
  return SWITCH_DEFAULT_ON.has(key)
}

function envToConfigValues(env: EnvMap): ConfigValues {
  const values: ConfigValues = { ...env }
  for (const key of SWITCH_CONFIG_KEYS) {
    values[key] = switchValue(env[key], key)
  }
  return values
}

function configValuesToEnv(values: ConfigValues): EnvMap {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]),
  )
}

export function useConfigPageState(appInfo: AppInfo | null) {
  const [values, setValues] = useState<ConfigValues>({})
  const [saved, flashSaved] = useTimedFlag(1600)
  const [resolvedAppInfo, setResolvedAppInfo] = useState<AppInfo | null>(null)
  const loadedRef = useRef(false)
  const lastSavedPayloadRef = useRef('')

  const loadConfig = useMemo(() => async (): Promise<ConfigPageData> => {
    const nextEnv = await window.videoAutoCut.readEnv()
    return { env: nextEnv }
  }, [])

  const applyConfig = useMemo(() => ({ env: nextEnv }: ConfigPageData) => {
    const nextValues = envToConfigValues(nextEnv)
    lastSavedPayloadRef.current = JSON.stringify(configValuesToEnv(nextValues))
    setValues(nextValues)
    loadedRef.current = true
  }, [])

  const { refresh: refreshConfig } = useAsyncRefresh({
    load: loadConfig,
    apply: applyConfig,
    auto: false,
  })

  useEffect(() => {
    refreshConfig().catch(() => undefined)
  }, [refreshConfig])

  function update(key: string, value: ConfigValue) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const storageInfo = resolvedAppInfo || appInfo
  const groups = configGroups

  const defaultWorkspaceDir = storageInfo?.dataRoot || ''
  const workspaceSpec: ConfigSpec = {
    key: 'VIDEOAUTO_WORKSPACE_DIR',
    label: '数据目录',
    description: '运行环境、素材、历史任务、临时文件和默认成品输出都会保存在这里；修改后重启生效。',
    type: 'directory',
    placeholder: defaultWorkspaceDir,
    defaultPath: defaultWorkspaceDir,
  }

  useEffect(() => {
    if (!loadedRef.current) return undefined
    const payload = JSON.stringify(configValuesToEnv(values))
    if (payload === lastSavedPayloadRef.current) return undefined

    const timer = window.setTimeout(() => {
      const currentPayload = payload
      window.videoAutoCut.writeEnv(configValuesToEnv(values))
        .then((nextEnv) => {
          const nextValues = envToConfigValues(nextEnv)
          lastSavedPayloadRef.current = JSON.stringify(configValuesToEnv(nextValues))
          setValues((current) => (
            JSON.stringify(configValuesToEnv(current)) === currentPayload ? nextValues : current
          ))
          return window.videoAutoCut.appInfo()
        })
        .then(setResolvedAppInfo)
        .then(() => flashSaved())
        .catch((error) => console.error('Auto save config failed:', error))
    }, 650)

    return () => window.clearTimeout(timer)
  }, [flashSaved, values])

  return {
    groups,
    saved,
    storageInfo,
    update,
    values,
    workspaceSpec,
  }
}
