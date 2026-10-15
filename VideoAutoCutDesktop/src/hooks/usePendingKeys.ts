import { useCallback, useRef, useState } from 'react'

import { useMountedRef } from './useMountedRef'

export function usePendingKeys<Key extends string>() {
  const pendingRef = useRef<Set<Key>>(new Set())
  const mountedRef = useMountedRef()
  const [pendingKeys, setPendingKeys] = useState<Set<Key>>(() => new Set())

  const setPendingRef = useCallback((next: Set<Key>) => {
    pendingRef.current = next
    if (mountedRef.current) setPendingKeys(next)
  }, [mountedRef])

  const runWithPending = useCallback(async <Result,>(key: Key, task: () => Promise<Result>): Promise<Result | undefined> => {
    if (pendingRef.current.has(key)) return undefined

    setPendingRef(new Set(pendingRef.current).add(key))
    try {
      return await task()
    } finally {
      const next = new Set(pendingRef.current)
      next.delete(key)
      setPendingRef(next)
    }
  }, [setPendingRef])

  return {
    pendingKeys,
    runWithPending,
  }
}
