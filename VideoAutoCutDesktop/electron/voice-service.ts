import fs from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, OpenDialogOptions } from 'electron'

import { IPC_EVENTS } from './ipc-channels.js'
import { ensureDir } from './utils.js'
import { asRecord, type FileEntry, type IpcSender, type MutableEnv } from './types.js'
import { spawnStreamingProcess } from './process-runner.js'
import { copyFilesIntoDirectory } from './file-entry.js'
import { VOICE_TEMPLATE_EXTENSIONS, extensionsForDialog } from './file-extensions.js'

interface VoiceServiceOptions {
  templatesDir: string
  registryPath: string
  getVideoAutoRoot: () => string
  getPythonPath: () => string
  createVideoAutoEnv: (extra?: MutableEnv) => NodeJS.ProcessEnv
  isRuntimeUsable: (root: string) => boolean
  listFilesSafe: (dir: string, exts?: string[] | null, limit?: number, maxDepth?: number) => FileEntry[]
  showOpenDialog: (parentWindow: BrowserWindow | null, options: OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
  send: IpcSender
}

interface VoiceCloneOptions {
  file?: string
  prefix?: string
}

interface VoiceRegistryItem {
  voice_id: string
  template_path: string
  prefix: string
  target_model: string
  upload_model: string
  language: string
  audio_url: string
  created_at: string
}

function createVoiceService(options: VoiceServiceOptions) {
  const templatesDir = options.templatesDir
  const registryPath = options.registryPath
  const getVideoAutoRoot = options.getVideoAutoRoot
  const getPythonPath = options.getPythonPath
  const createVideoAutoEnv = options.createVideoAutoEnv
  const isRuntimeUsable = options.isRuntimeUsable
  const listFilesSafe = options.listFilesSafe
  const showOpenDialog = options.showOpenDialog
  const send = options.send

  function listRegistry(): VoiceRegistryItem[] {
    ensureDir(templatesDir)
    if (!fs.existsSync(registryPath)) return []
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
      return Array.isArray(data)
        ? data
          .map(asRecord)
          .filter((item) => item.voice_id)
          .map((item) => ({
            voice_id: String(item.voice_id || ''),
            template_path: String(item.template_path || ''),
            prefix: String(item.prefix || ''),
            target_model: String(item.target_model || ''),
            upload_model: String(item.upload_model || ''),
            language: String(item.language || ''),
            audio_url: String(item.audio_url || ''),
            created_at: String(item.created_at || ''),
          }))
        : []
    } catch (_error) {
      return []
    }
  }

  async function clone(options: VoiceCloneOptions = {}) {
    const root = getVideoAutoRoot()
    if (!isRuntimeUsable(root)) return { ok: false }
    const script = path.join(root, 'tools', 'register_voice_template.py')
    const args = [script]
    if (options.file) args.push('--file', options.file)
    if (options.prefix) args.push('--prefix', options.prefix)
    const pythonPath = getPythonPath()
    const child = spawnStreamingProcess({
      channel: IPC_EVENTS.voice,
      command: pythonPath,
      args,
      cwd: root,
      env: createVideoAutoEnv(),
      send,
    })
    return { ok: true, pid: child.pid }
  }

  function templates() {
    ensureDir(templatesDir)
    return listFilesSafe(templatesDir, VOICE_TEMPLATE_EXTENSIONS, 100)
  }

  async function importTemplate(parentWindow: BrowserWindow | null) {
    ensureDir(templatesDir)
    const res = await showOpenDialog(parentWindow, {
      title: '添加声音模板',
      filters: [{ name: 'Audio', extensions: extensionsForDialog(VOICE_TEMPLATE_EXTENSIONS) }],
      properties: ['openFile', 'multiSelections'],
    })
    if (res.canceled) return []
    return copyFilesIntoDirectory(res.filePaths, templatesDir, { allowedExtensions: VOICE_TEMPLATE_EXTENSIONS })
  }

  return {
    clone,
    importTemplate,
    listRegistry,
    templates,
  }
}

export {
  createVoiceService,
}
