import { useCallback, useEffect, useRef } from 'react'

export function useTimeoutRegistry() {
  const timersRef = useRef<Set<number>>(new Set())

  const clearTimeout = useCallback((timer: number | null | undefined) => {
    if (timer === null || timer === undefined) return
    window.clearTimeout(timer)
    timersRef.current.delete(timer)
  }, [])

  const clearAllTimeouts = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
    timersRef.current.clear()
  }, [])

  const scheduleTimeout = useCallback((callback: () => void, delay: number): number => {
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer)
      callback()
    }, delay)
    timersRef.current.add(timer)
    return timer
  }, [])

  useEffect(() => clearAllTimeouts, [clearAllTimeouts])

  return {
    clearAllTimeouts,
    clearTimeout,
    scheduleTimeout,
  }
}
