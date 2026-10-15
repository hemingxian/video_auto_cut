import type { BrowserWindow } from 'electron'

const MAIN_WINDOW_BOUNDS = {
  width: 1320,
  height: 860,
  minWidth: 1120,
  minHeight: 720,
}

const AUTH_WINDOW_BOUNDS = {
  width: 520,
  height: 620,
  minWidth: 460,
  minHeight: 560,
}

function getInitialWindowBounds(isLoggedIn: boolean) {
  return isLoggedIn ? MAIN_WINDOW_BOUNDS : AUTH_WINDOW_BOUNDS
}

function setWindowMode(window: BrowserWindow | null, mode = 'main') {
  if (!window || window.isDestroyed()) return { ok: false }

  const bounds = mode === 'auth' ? AUTH_WINDOW_BOUNDS : MAIN_WINDOW_BOUNDS
  window.setMinimumSize(bounds.minWidth, bounds.minHeight)

  const current = window.getBounds()
  if (Math.abs(current.width - bounds.width) > 20 || Math.abs(current.height - bounds.height) > 20) {
    window.setSize(bounds.width, bounds.height, true)
    window.center()
  }

  return { ok: true, mode }
}

export {
AUTH_WINDOW_BOUNDS,
  MAIN_WINDOW_BOUNDS,
  getInitialWindowBounds,
  setWindowMode,
}
