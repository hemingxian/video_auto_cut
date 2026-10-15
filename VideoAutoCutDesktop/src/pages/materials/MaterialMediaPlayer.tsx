import { Film } from 'lucide-react'
import {
  MediaControlBar,
  MediaController,
  MediaDurationDisplay,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPipButton,
  MediaPlaybackRateButton,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react'
import { useEffect, useRef, useState } from 'react'
import type { ComponentRef } from 'react'

import { cx } from '../../lib/className'

export function MaterialMediaPlayer({
  autoPlay = false,
  compact = false,
  focusOnMount = false,
  src,
  title,
}: {
  autoPlay?: boolean
  compact?: boolean
  focusOnMount?: boolean
  src?: string
  title: string
}) {
  const [failedSrc, setFailedSrc] = useState<string>()
  const clickTimerRef = useRef<number | null>(null)
  const controllerRef = useRef<ComponentRef<typeof MediaController>>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const loadFailed = Boolean(src && failedSrc === src)

  useEffect(() => {
    setFailedSrc(undefined)
  }, [src])

  useEffect(() => {
    if (!focusOnMount || !src || loadFailed) return
    const frame = window.requestAnimationFrame(() => controllerRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [focusOnMount, loadFailed, src])

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
  }, [])

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const handleVideoClick = () => {
    controllerRef.current?.focus()
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      togglePlayback()
    }, 220)
  }

  const handleVideoDoubleClick = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    const controller = controllerRef.current
    if (!controller) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void controller.requestFullscreen()
  }

  if (!src || loadFailed) {
    return <div className={cx('material-media-player-fallback', compact && 'compact')}>
      <Film />
      <strong>{src ? '无法在应用内预览该视频' : '本地视频尚未就绪'}</strong>
      <span>{src ? '可以使用系统默认播放器打开。' : '下载到本地后即可预览。'}</span>
    </div>
  }

  return <MediaController
    ref={controllerRef}
    className={cx('material-media-player', compact && 'compact')}
    aria-label={`视频预览：${title}`}
    lang="zh-CN"
    tabIndex={0}
  >
    <video
      ref={videoRef}
      slot="media"
      src={src}
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      onClick={handleVideoClick}
      onDoubleClick={handleVideoDoubleClick}
      onError={() => setFailedSrc(src)}
    />
    <MediaLoadingIndicator />
    <MediaPlayButton
      className="material-media-player-center-play"
      aria-label="播放或暂停"
      title="播放或暂停"
    />
    <MediaControlBar className="material-media-player-controls">
      <MediaPlayButton aria-label="播放或暂停" title="播放或暂停" />
      <MediaSeekBackwardButton seekOffset={10} title="后退 10 秒" />
      <MediaSeekForwardButton seekOffset={10} title="前进 10 秒" />
      <MediaTimeDisplay />
      <span className="material-media-player-time-divider">/</span>
      <MediaDurationDisplay />
      <MediaTimeRange />
      <MediaMuteButton title="静音" />
      <MediaVolumeRange />
      <MediaPlaybackRateButton rates={[0.5, 0.75, 1, 1.25, 1.5, 2]} title="播放速度" />
      <MediaPipButton title="画中画" />
      <MediaFullscreenButton title="全屏" />
    </MediaControlBar>
  </MediaController>
}
