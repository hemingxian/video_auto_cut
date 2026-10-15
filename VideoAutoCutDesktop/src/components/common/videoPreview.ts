import type { MouseEventHandler } from 'react'

export const previewVideoPlay: MouseEventHandler<HTMLVideoElement> = (event) => {
  event.currentTarget.play().catch(() => undefined)
}

export const previewVideoPause: MouseEventHandler<HTMLVideoElement> = (event) => {
  event.currentTarget.pause()
}
