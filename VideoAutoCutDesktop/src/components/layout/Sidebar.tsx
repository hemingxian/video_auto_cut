import { UserCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import appIconUrl from '../../assets/app-icon.png'
import { navItems } from '../../config/navigation'
import { cx } from '../../lib/className'
import { formatCurrency } from '../../lib/format'
import type { AppInfo, NavItem, Page } from '../../types/app'
import type { AuthState } from '../../types/videoauto'

function SidebarIconButton({
  active,
  ariaLabel,
  children,
  className,
  onClick,
  title,
}: {
  active?: boolean
  ariaLabel: string
  children: ReactNode
  className?: string
  onClick: () => void
  title: string
}) {
  return <button className={cx('sidebar-icon-button', active && 'active', className)} title={title} aria-label={ariaLabel} onClick={onClick}>
    {children}
  </button>
}

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon
  return <SidebarIconButton className="nav-item" active={active} title={`${item.label}\n${item.description}`} ariaLabel={item.label} onClick={onClick}>
    <Icon className="nav-icon" />
  </SidebarIconButton>
}

export function Sidebar({
  activePage,
  appInfo,
  auth,
  onNavigate,
  onAccount,
}: {
  activePage: Page
  appInfo?: AppInfo | null
  auth: AuthState
  onNavigate: (page: Page) => void
  onAccount: () => void
}) {
  const mainNavItems = navItems.filter((item) => item.id !== 'config')
  const settingsItem = navItems.find((item) => item.id === 'config')
  const user = auth.user
  const accountText = user?.email || user?.phone || user?.displayName || user?.username || '账号'
  const accountTitle = auth.loggedIn && user
    ? `${accountText}\n余额 ${user.balanceKnown === false ? '暂未获取' : formatCurrency(user.balance)}`
    : '账号'
  return <aside className="sidebar">
    <div className="brand" title={`VideoAutoCut Studio v${appInfo?.version || '0.1.0'}`} aria-label="VideoAutoCut Studio">
      <div className="brand-mark app-brand-mark"><img src={appIconUrl} alt="" /></div>
    </div>

    <nav className="nav-list">
      {mainNavItems.map((item) => <NavButton key={item.id} item={item} active={activePage === item.id} onClick={() => onNavigate(item.id)} />)}
    </nav>

    <div className="sidebar-bottom">
      <SidebarIconButton className="account-dock-button" title={accountTitle} ariaLabel="账号" onClick={onAccount}>
        <UserCircle className="account-email-icon" />
        <span className={cx('account-status-dot', auth.loggedIn && user && 'online')} />
      </SidebarIconButton>
      {settingsItem ? <NavButton item={settingsItem} active={activePage === settingsItem.id} onClick={() => onNavigate(settingsItem.id)} /> : null}
    </div>

  </aside>
}
