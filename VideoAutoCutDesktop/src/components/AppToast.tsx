import './AppToast.css'

export function AppToast({ message }: { message: string }) {
  if (!message) return null

  return <div className="saved-toast">{message}</div>
}
