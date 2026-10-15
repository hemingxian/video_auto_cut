import fs from 'node:fs'
import path from 'node:path'

interface RuntimePathStateOptions {
  initialRoot: string
  engineExeName: string
}

function prepareDevelopmentDependencies(root: string, installedRoot: string): void {
  if (!installedRoot || path.resolve(root) === path.resolve(installedRoot)) return
  for (const name of ['python-3.11.9-embed-amd64', 'sentrysearch/.venv', 'ffmpeg', 'node-runtime', 'yt-dlp.exe']) {
    const target = path.join(root, name)
    const source = path.join(installedRoot, name)
    if (fs.existsSync(target) || !fs.existsSync(source)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, target, 'junction')
    else fs.copyFileSync(source, target)
  }
}

function firstExistingPath(paths: string[]): string {
  return paths.find((item) => fs.existsSync(item)) || paths[0]
}

function createRuntimePathState({ initialRoot, engineExeName }: RuntimePathStateOptions) {
  const state = {
    videoAutoRoot: initialRoot,
    exePath: '',
    pythonPath: '',
    sentrySearchRoot: '',
    sentrySearchExe: '',
    sentrySearchPython: '',
    sentrySearchEntry: '',
  }

  function update(root = state.videoAutoRoot): void {
    state.videoAutoRoot = root
    state.exePath = path.join(state.videoAutoRoot, engineExeName)
    state.pythonPath = path.join(state.videoAutoRoot, 'python-3.11.9-embed-amd64', 'python.exe')
    state.sentrySearchRoot = firstExistingPath([
      path.join(state.videoAutoRoot, 'sentrysearch'),
      path.resolve(state.videoAutoRoot, '..', 'sentrysearch'),
    ])
    state.sentrySearchExe = path.join(state.sentrySearchRoot, 'dist', 'sentrysearch', 'sentrysearch.exe')
    state.sentrySearchPython = firstExistingPath([
      state.pythonPath,
      path.join(state.sentrySearchRoot, '.venv', 'Scripts', 'python.exe'),
    ])
    state.sentrySearchEntry = path.join(state.sentrySearchRoot, 'sentrysearch_entry.py')
  }

  update(initialRoot)

  return {
    get videoAutoRoot() { return state.videoAutoRoot },
    get exePath() { return state.exePath },
    get pythonPath() { return state.pythonPath },
    get sentrySearchRoot() { return state.sentrySearchRoot },
    get sentrySearchExe() { return state.sentrySearchExe },
    get sentrySearchPython() { return state.sentrySearchPython },
    get sentrySearchEntry() { return state.sentrySearchEntry },
    update,
  }
}

export {
  prepareDevelopmentDependencies,
  createRuntimePathState,
}
