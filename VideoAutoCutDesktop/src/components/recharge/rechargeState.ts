import type { RechargeStatusResult } from '../../types/videoauto'

export const PRESET_AMOUNTS = [10, 100, 1000, 10000] as const

export const PAID_STATUSES = new Set(['PAID', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'TRADE_SUCCESS', 'TRADE_FINISHED'])
export const PENDING_STATUSES = new Set(['', 'PENDING', 'WAITING', 'UNPAID', 'CREATED', 'PROCESSING', 'WAIT_BUYER_PAY'])
export const TERMINAL_FAILED_STATUSES = new Set(['FAILED', 'EXPIRED', 'CANCELLED'])

export function normalizePaymentStatus(status: unknown) {
  return String(status || '').toUpperCase()
}

export function isPaidStatus(result: RechargeStatusResult) {
  const status = normalizePaymentStatus(result.orderStatus)
  return PAID_STATUSES.has(status) || Boolean(result.paidAt || result.completedAt)
}

export function isTerminalFailedStatus(status: string) {
  return TERMINAL_FAILED_STATUSES.has(normalizePaymentStatus(status))
}

export function isPendingStatus(status: string) {
  return PENDING_STATUSES.has(normalizePaymentStatus(status))
}

export function paymentFailedMessage(status: string) {
  return normalizePaymentStatus(status) === 'EXPIRED'
    ? '订单已过期，请返回重新发起支付'
    : '支付未完成，请返回重新发起支付'
}
