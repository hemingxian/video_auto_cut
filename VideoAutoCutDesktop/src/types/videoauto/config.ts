export type ProgressTemplateSettings = Record<string, string>

export type ProgressTemplateRecord = {
  key: string
  label: string
  tone: string
  settings: ProgressTemplateSettings
  createdAt?: string
  updatedAt?: string
}
