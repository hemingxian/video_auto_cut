import { useCallback, useEffect, useRef, useState } from 'react'

import { useMountedRef } from './useMountedRef'

interface AsyncRefreshOptions<Value> {
  apply: (value: Value) => void
  auto?: boolean
  initialLoading?: boolean
  load: () => Promise<Value>
  onError?: (error: unknown) => void
}

export function useAsyncRefresh<Value>({
  apply,
  auto = true,
  initialLoading = false,
  load,
  onError,
}: AsyncRefreshOptions<Value>) {
  const mountedRef = useMountedRef()
  const latestRequestRef = useRef(0)
  const [loading, setLoading] = useState(initialLoading)

  const refresh = useCallback(async () => {
    const requestId = latestRequestRef.current + 1
    latestRequestRef.current = requestId
    if (mountedRef.current) setLoading(true)

    try {
      const value = await load()
      if (mountedRef.current && latestRequestRef.current === requestId) apply(value)
      return value
    } catch (error) {
      if (mountedRef.current && latestRequestRef.current === requestId) onError?.(error)
      throw error
    } finally {
      if (mountedRef.current && latestRequestRef.current === requestId) setLoading(false)
    }
  }, [apply, load, mountedRef, onError])

  useEffect(() => {
    if (!auto) return
    refresh().catch(() => undefined)
  }, [auto, refresh])

  return {
    loading,
    refresh,
  }
}
