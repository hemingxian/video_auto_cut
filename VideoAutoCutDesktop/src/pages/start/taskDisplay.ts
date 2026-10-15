import type { RunningTask } from '../../types/videoauto'
import { basename } from '../../lib/path'

export type TaskDisplayKind = 'script-plan' | 'script-generate' | 'shots-generate'

export type TaskDisplayMeta = {
  kind: TaskDisplayKind
  label: string
  path: string
  stage: string
}

function commandTokens(command = '') {
  const tokens: string[] = []
  const pattern = /"((?:\\.|[^"\\])*)"/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(command))) {
    try {
      tokens.push(JSON.parse(match[0]) as string)
    } catch {
      tokens.push(match[1])
    }
  }

  return tokens
}

export function commandArg(command: string | undefined, flag: string) {
  const tokens = commandTokens(command)
  const index = tokens.indexOf(flag)
  return index >= 0 ? tokens[index + 1] || '' : ''
}

export function taskDisplayMeta(task?: Pick<RunningTask, 'command'> | null): TaskDisplayMeta {
  const command = task?.command || ''
  const planOnly = command.includes('--plan-only')
  const script = commandArg(command, '--script-file')
  const shotsJson = commandArg(command, '--shots-json')
  const path = script || shotsJson

  return {
    kind: planOnly ? 'script-plan' : shotsJson ? 'shots-generate' : 'script-generate',
    label: basename(path, '未命名任务'),
    path,
    stage: planOnly ? '整理分镜' : '生成视频',
  }
}
