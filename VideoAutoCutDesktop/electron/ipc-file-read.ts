import { IPC_INVOKE } from './ipc-channels.js'

type FileReadHandler = (event: unknown, file: unknown, max?: unknown) => unknown
type HandleRegistrar = (channel: typeof IPC_INVOKE.fileRead, handler: FileReadHandler) => void

export function registerFileReadHandler(
  handle: HandleRegistrar,
  readTextFile: (file: unknown, max?: number) => unknown,
): void {
  handle(IPC_INVOKE.fileRead, (_event, file, max) => {
    const maxBytes = Number(max)
    return readTextFile(file, Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined)
  })
}
