import { useCallback, useRef, useState } from 'react'

import { useMountedRef } from './useMountedRef'

export function useBusyAction(initialBusy = false) {
  const activeCountRef = useRef(0)
  const mountedRef = useMountedRef()
  const [busy, setBusy] = useState(initialBusy)

  const runBusy = useCallback(async <Result,>(task: () => Promise<Result>): Promise<Result> => {
    activeCountRef.current += 1
    if (mountedRef.current) setBusy(true)

    try {
      return await task()
    } finally {
      activeCountRef.current = Math.max(0, activeCountRef.current - 1)
      if (mountedRef.current && activeCountRef.current === 0) setBusy(false)
    }
  }, [mountedRef])

  return [busy, runBusy] as const
}
