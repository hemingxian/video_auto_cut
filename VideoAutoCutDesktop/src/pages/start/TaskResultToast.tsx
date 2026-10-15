import { AlertCircle, CheckCircle2 } from 'lucide-react'

export function TaskResultToast({ message, tone }: {
  message: string
  tone: 'success' | 'error'
}) {
  if (!message) return null
  const failed = tone === 'error'
  return <div className={`saved-toast${failed ? ' is-error' : ''}`}>
    {failed ? <AlertCircle className="button-icon" /> : <CheckCircle2 className="button-icon" />}
    {message}
  </div>
}
