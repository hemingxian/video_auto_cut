import type { VideoAutoCutApi } from './videoauto-api'

declare global {
  interface Window {
    videoAutoCut: VideoAutoCutApi
  }
}

export {}
