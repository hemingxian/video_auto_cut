import { useCallback, useEffect, useRef } from 'react'

export function useTimeoutScheduler() {
  const timerRef = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (!timerRef.current) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const schedule = useCallback((callback: () => void, duration: number) => {
    clear()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      callback()
    }, duration)
  }, [clear])

  useEffect(() => clear, [clear])

  return {
    clear,
    schedule,
  }
}
