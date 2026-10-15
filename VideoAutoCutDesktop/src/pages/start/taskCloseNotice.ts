export type CloseToast = (message: string, tone?: 'success' | 'error') => void

function asSentence(message: string): string {
  const value = message.trim()
  if (!value || /[。！？.!?]$/.test(value)) return value
  return `${value}。`
}

export function taskResultToast(
  taskStage: string,
  workflowStage: string | undefined,
  workflowProgress: { phase?: string; label?: string } | undefined,
  code: number | undefined,
  blockedCount = 0,
): string {
  if (code !== 0) {
    if (workflowProgress?.phase === 'cancelled') return '任务已停止。'
    if (blockedCount > 0) return '脚本导入被拦下，请查看问题详情。'
    return workflowStage === 'bgm'
      ? asSentence(workflowProgress?.label || '背景音乐处理失败，请查看日志')
      : '任务结束，请查看日志。'
  }
  return taskStage === 'plan' ? '分镜已整理好，可以继续生成视频。' : '任务已完成。'
}

export async function notifyTaskClose(
  load: () => Promise<unknown>,
  showToast: CloseToast,
  message: string,
  failed: boolean,
): Promise<void> {
  if (failed) showToast(message, 'error')
  try {
    await load()
    if (!failed) showToast(message, 'success')
  } catch { /* A missing plan must not suppress an already reported failure. */ }
}
