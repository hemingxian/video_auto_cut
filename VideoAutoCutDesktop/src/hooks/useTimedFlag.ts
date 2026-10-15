import { useCallback, useState } from 'react'

import { useTimeoutScheduler } from './useTimeoutScheduler'

export function useTimedFlag(duration = 1600) {
  const [active, setActive] = useState(false)
  const { schedule } = useTimeoutScheduler()

  const show = useCallback(() => {
    setActive(true)
    schedule(() => {
      setActive(false)
    }, duration)
  }, [duration, schedule])

  return [active, show] as const
}
