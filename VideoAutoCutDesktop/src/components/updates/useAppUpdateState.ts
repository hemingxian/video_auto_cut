import { useEffect, useState } from 'react'

import { useMountedRef } from '../../hooks/useMountedRef'
import type { UpdateState } from '../../types/videoauto'
import { defaultUpdateState } from './updateState'

export function useAppUpdateState(currentVersion = '') {
  const [appUpdate, setAppUpdate] = useState<UpdateState>(() => defaultUpdateState(currentVersion))
  const mountedRef = useMountedRef()

  useEffect(() => {
    window.videoAutoCut.updateStatus()
      .then((next) => {
        if (mountedRef.current) setAppUpdate(next)
      })
      .catch(() => undefined)

    const offUpdate = window.videoAutoCut.onUpdateEvent((next) => {
      if (mountedRef.current) setAppUpdate(next)
    })
    return () => {
      offUpdate()
    }
  }, [mountedRef])

  return [appUpdate, setAppUpdate] as const
}
