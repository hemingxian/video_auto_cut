import { dirname } from '../../lib/path'

function reportFileActionError(action: string, target: string, error: unknown) {
  console.error(`[VideoAutoCut] ${action} failed`, { target, error })
}

export function openFilePath(file: string) {
  if (!file) return
  void window.videoAutoCut.openFile(file).catch((error) => reportFileActionError('open file', file, error))
}

export function openContainingFolder(file: string) {
  if (!file) return
  const folder = dirname(file)
  void window.videoAutoCut.openFolder(folder).catch((error) => reportFileActionError('open folder', folder, error))
}

export function revealScript(file: string) {
  if (!file) return
  void window.videoAutoCut.revealScript(file).catch((error) => reportFileActionError('reveal script', file, error))
}

export function openFolderPath(folder: string) {
  if (!folder) return
  void window.videoAutoCut.openFolder(folder).catch((error) => reportFileActionError('open folder', folder, error))
}
