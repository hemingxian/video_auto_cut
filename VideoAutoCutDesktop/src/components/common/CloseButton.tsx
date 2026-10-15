import { X } from 'lucide-react'

type CloseButtonProps = {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  iconClassName?: string
  onClick: () => void
}

export function CloseButton({
  ariaLabel = '关闭',
  className,
  disabled = false,
  iconClassName = 'button-icon',
  onClick,
}: CloseButtonProps) {
  return <button
    type="button"
    className={['close-button', className].filter(Boolean).join(' ')}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={onClick}
  >
    <X className={iconClassName} />
  </button>
}
