import progressTemplatesJson from '../../../VideoAutoCut/config/progress-templates.json'
import type { ProgressTemplateRecord } from '../types/videoauto'

export const progressTemplates = progressTemplatesJson as ProgressTemplateRecord[]

export function findProgressTemplate(key: string) {
  return progressTemplates.find((template) => template.key === key) || progressTemplates[0]
}
