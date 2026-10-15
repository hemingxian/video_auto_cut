import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'

import { errorMessage, type CommandResult, type IpcSender } from './types.js'

interface StreamProcessOptions extends SpawnOptionsWithoutStdio {
  channel: string
  command: string
  args: string[]
  onClose?: (code: number | null) => void
  send: IpcSender
}

interface OutputHandlers {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

function commandText(command: string, args: string[]): string {
  return [command, ...args].map((part) => JSON.stringify(part)).join(' ')
}

function attachOutputListeners(child: ChildProcessWithoutNullStreams, handlers: OutputHandlers): void {
  child.stdout.on('data', (data: Buffer) => handlers.stdout(data.toString('utf8')))
  child.stderr.on('data', (data: Buffer) => handlers.stderr(data.toString('utf8')))
}

function closeProcessInput(child: ChildProcessWithoutNullStreams): void {
  child.stdin.on('error', () => undefined)
  child.stdin.end()
}

function spawnStreamingProcess(options: StreamProcessOptions): ChildProcessWithoutNullStreams {
  const { channel, command, args, onClose, send, ...spawnOptions } = options
  const child = spawn(command, args, { ...spawnOptions, windowsHide: true })
  const pid = child.pid

  send(channel, { type: 'start', pid, command: commandText(command, args) })
  attachOutputListeners(child, {
    stdout: (text) => send(channel, { type: 'stdout', pid, command: commandText(command, args), text }),
    stderr: (text) => send(channel, { type: 'stderr', pid, command: commandText(command, args), text }),
  })
  closeProcessInput(child)
  child.on('error', (error) => send(channel, { type: 'stderr', pid, command: commandText(command, args), text: errorMessage(error) }))
  child.on('close', (code) => {
    send(channel, { type: 'close', pid, command: commandText(command, args), code })
    onClose?.(code)
  })

  return child
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve()

  if (process.platform !== 'win32' || !child.pid) {
    child.kill('SIGTERM')
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    killer.on('error', () => {
      child.kill('SIGTERM')
      resolve()
    })
    killer.on('close', () => resolve())
  })
}

function runCapture(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<CommandResult> {
  const { signal, ...spawnOptions } = options
  if (signal?.aborted) return Promise.resolve({ code: null, stdout: '', stderr: '进程执行已取消' })
  return new Promise((resolve) => {
    // Own cancellation here: Node's default AbortSignal only kills the direct
    // child, leaving FFmpeg children alive on Windows.
    const child = spawn(command, args, { ...spawnOptions, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let stopping: Promise<void> | undefined
    const abort = () => { stopping ||= terminateProcessTree(child) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()

    attachOutputListeners(child, {
      stdout: (text) => { stdout += text },
      stderr: (text) => { stderr += text },
    })
    child.on('error', (error) => { stderr = errorMessage(error) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      const result = { code: signal?.aborted ? null : code, stdout,
        stderr: signal?.aborted ? '进程执行已取消' : stderr }
      if (stopping) void stopping.then(() => resolve(result), () => resolve(result))
      else resolve(result)
    })
  })
}

async function runCheckedProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<CommandResult> {
  const result = await runCapture(command, args, options)
  if (result.code === 0) return result

  throw new Error([result.stderr, result.stdout, `${command} exited with code ${result.code}`].filter(Boolean).join('\n'))
}

export {
  commandText,
  runCapture,
  runCheckedProcess,
  spawnStreamingProcess,
  terminateProcessTree,
}
