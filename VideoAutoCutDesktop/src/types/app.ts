import type { ComponentType } from 'react'
import type { FileItem, RuntimeState } from './videoauto'

export type Page = 'start' | 'runs' | 'materials' | 'config' | 'voice'

export type AppInfo = {
  videoAutoRoot: string
  userDataRoot: string
  configDir: string
  dataRoot: string
  exePath: string
  envPath: string
  runsDir: string
  defaultOutputDir: string
  outputDir: string
  materialsDir: string
  version: string
  runtime: RuntimeState
}

export type NavItem = {
  id: Page
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}

export type MaterialKind = 'user' | 'raw'

export type MaterialCardItem = FileItem & {
  kind: MaterialKind
  kindLabel: string
  group: string
  projectName: string
  runId: string
}

export type ConfigValue = string | boolean

export type ConfigSpec = {
  key: string
  label: string
  description: string
  type: 'text' | 'password' | 'number' | 'select' | 'switch' | 'color' | 'directory'
  placeholder?: string
  suffix?: string
  defaultPath?: string
  options?: Array<{ label: string; value: string }>
}

export type ConfigGroup = {
  title: string
  description: string
  icon: ComponentType<{ className?: string }>
  items: ConfigSpec[]
}




