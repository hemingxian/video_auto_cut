const MP4_EXTENSIONS = ['.mp4']
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac']
const VOICE_TEMPLATE_EXTENSIONS = ['.mp3', '.wav', '.m4a']
const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls']
const SCRIPT_EXTENSIONS = [...SPREADSHEET_EXTENSIONS, '.docx', '.doc', '.pdf', '.txt', '.md', '.csv', '.json', '.srt']
const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.vtt']
const DATA_EXTENSIONS = ['.json', '.xlsx', '.xlsm', '.csv', '.txt', '.log']
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']
const RUN_ARTIFACT_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...SUBTITLE_EXTENSIONS,
  ...DATA_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]

function extensionsForDialog(extensions: string[]): string[] {
  return extensions.map((extension) => extension.replace(/^\./, ''))
}

export {
  AUDIO_EXTENSIONS,
  DATA_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MP4_EXTENSIONS,
  RUN_ARTIFACT_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  VOICE_TEMPLATE_EXTENSIONS,
  extensionsForDialog,
}
