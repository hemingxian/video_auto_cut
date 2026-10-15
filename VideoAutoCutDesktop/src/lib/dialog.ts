interface OperationResult {
  ok: boolean
  message?: string
}

export function confirmDestructiveAction(message: string) {
  return window.confirm(message)
}

export function reportOperationResult(result: OperationResult, fallbackMessage: string) {
  if (!result.ok) {
    window.alert(result.message || fallbackMessage)
    return false
  }

  if (result.message) window.alert(result.message)
  return true
}
