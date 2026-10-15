import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'

import { videoPreviewSeekTime } from './videoPreviewModel'

export function useLazyVideoPreview() {
  const hostRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [activated, setActivated] = useState(false)
  const [duration, setDuration] = useState(0)
  const [frameReady, setFrameReady] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    const element = hostRef.current
    if (!element || activated) return

    if (typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => setActivated(true), 0)
      return () => window.clearTimeout(timer)
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setActivated(true)
      observer.disconnect()
    }, { threshold: 0.01 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [activated])

  const handleLoadedMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    const seekTime = videoPreviewSeekTime(video.duration)
    if (seekTime <= 0) return
    try {
      video.currentTime = seekTime
    } catch {
      // Some codecs cannot seek until more metadata is available; loadeddata still exposes frame zero.
    }
  }, [])

  const handleError = useCallback(() => {
    setLoadFailed(true)
    setFrameReady(false)
    setDuration(0)
  }, [])

  useEffect(() => () => videoRef.current?.pause(), [])

  return {
    activated,
    duration,
    frameReady,
    handleError,
    handleLoadedMetadata,
    hostRef,
    loadFailed,
    setFrameReady,
    videoRef,
  }
}
