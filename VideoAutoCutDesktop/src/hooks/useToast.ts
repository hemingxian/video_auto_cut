import { useCallback, useState } from 'react'

import { useTimeoutScheduler } from './useTimeoutScheduler'

export function useToast(duration = 2400) {
  const [message, setMessage] = useState('')
  const [tone, setTone] = useState<'success' | 'error'>('success')
  const { schedule } = useTimeoutScheduler()

  const showToast = useCallback((nextMessage: string, nextTone: 'success' | 'error' = 'success') => {
    setMessage(nextMessage)
    setTone(nextTone)
    schedule(() => {
      setMessage('')
    }, duration)
  }, [duration, schedule])

  return {
    toast: message,
    toastTone: tone,
    showToast,
  }
}
