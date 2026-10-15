import { useEffect, useRef, useState } from 'react'

import { useMountedRef } from '../../hooks/useMountedRef'
import type { RuntimeState } from '../../types/videoauto'

export function useRuntimeState(initialRuntime: RuntimeState | null = null, onRuntimeChange?: (runtime: RuntimeState) => void) {
  const [runtime, setRuntime] = useState<RuntimeState | null>(initialRuntime)
  const [loaded, setLoaded] = useState(Boolean(initialRuntime))
  const mountedRef = useMountedRef()
  const onRuntimeChangeRef = useRef(onRuntimeChange)

  useEffect(() => {
    onRuntimeChangeRef.current = onRuntimeChange
  }, [onRuntimeChange])

  useEffect(() => {
    window.videoAutoCut.runtimeStatus()
      .then((next) => {
        if (!mountedRef.current) return
        setRuntime(next)
        onRuntimeChangeRef.current?.(next)
        setLoaded(true)
      })
      .catch(() => {
        if (mountedRef.current) setLoaded(true)
      })

    const offRuntime = window.videoAutoCut.onRuntimeEvent((next) => {
      if (!mountedRef.current) return
      setRuntime(next)
      onRuntimeChangeRef.current?.(next)
    })
    return () => {
      offRuntime()
    }
  }, [mountedRef])

  return [runtime, setRuntime, loaded] as const
}
