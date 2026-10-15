export type AuthUser = {
  id: string | number
  email?: string | null
  username?: string | null
  phone?: string | null
  avatarUrl?: string | null
  role?: string
  status?: string
  displayName?: string | null
  balance: number
  balanceKnown?: boolean
  totalRecharged?: number
  concurrency?: number
  rpmLimit?: number
}

export type AuthState = {
  loggedIn: boolean
  user: AuthUser | null
  expiresAt?: string
  updatedAt?: string
}

export type AuthResult = {
  ok: boolean
  message?: string
  warning?: string
  status?: number
  reason?: string
  retryAfterSeconds?: number
  auth?: AuthState
}

export type AuthCaptchaResult = AuthResult & {
  captchaToken?: string
  svg?: string
}

export type RechargeResult = AuthResult & {
  orderId?: number
  amount?: number
  payAmount?: number
  outTradeNo?: string
  contentType?: string
  qrCode?: string
  payUrl?: string
  paymentType?: string
  expiresAt?: string
  paymentMode?: string
  raw?: unknown
}

export type RechargeStatusResult = AuthResult & {
  orderId?: number
  outTradeNo?: string
  orderStatus?: string
  amount?: number
  payAmount?: number
  paidAt?: string
  completedAt?: string
  raw?: unknown
}
