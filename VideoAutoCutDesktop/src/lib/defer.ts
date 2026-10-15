export function deferToNextTick(callback: () => void) {
  const timer = window.setTimeout(callback, 0)
  return () => window.clearTimeout(timer)
}
