import { LogOut } from 'lucide-react'

import type { AuthState } from '../types/videoauto'
import { formatBalance } from './account/accountFormat'
import { CloseButton } from './common/CloseButton'
import './AccountPopover.css'

export function AccountPopover({
  open,
  auth,
  onClose,
  onRecharge,
  onLogout,
}: {
  open: boolean
  auth: AuthState
  onClose: () => void
  onRecharge: () => void
  onLogout: () => void
}) {
  const user = auth.user

  if (!open || !user) return null

  const account = user.email || user.phone || user.displayName || user.username || '账号'

  return <div className="account-popover-overlay" onClick={onClose}>
    <div className="account-popover" onClick={(event) => event.stopPropagation()}>
      <div className="account-popover-head">
        <div>
          <strong>{account}</strong>
          <span className="account-head-balance">
            余额 {user.balanceKnown === false ? '暂未获取' : `¥${formatBalance(user.balance)}`}
            <button type="button" onClick={onRecharge}>充值</button>
          </span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <button type="button" className="account-logout" onClick={onLogout}>
        <LogOut className="button-icon" />退出登录
      </button>
    </div>
  </div>
}
