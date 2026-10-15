import { cleanConfiguredPath, firstCleanValue } from './utils.js'
import { asRecord, optionalNumberValue, type JsonRecord } from './types.js'

interface RechargeStatus {
  orderId?: number
  outTradeNo: string
  orderStatus: string
  amount?: number
  payAmount?: number
  paidAt: string
  completedAt: string
}

function normalizeRechargeErrorMessage(message: unknown): string {
  const text = String(message || '').trim()
  if (/user\s+not\s+found/i.test(text)) {
    return '充值服务未识别当前登录账号，请重新登录后再试。'
  }
  return text || '创建充值订单失败'
}

function normalizeQrCode(value: unknown): string {
  const text = cleanConfiguredPath(value)
  if (!text) return ''
  if (/^data:image\//i.test(text)) return text
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length > 100) {
    try {
      const buffer = Buffer.from(text, 'base64')
      if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return `data:image/png;base64,${text}`
      }
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return `data:image/jpeg;base64,${text}`
      }
      if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return `data:image/webp;base64,${text}`
      }
      if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
        return `data:image/gif;base64,${text}`
      }
    } catch (_error) {
      return text
    }
  }
  return text
}

function firstNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = optionalNumberValue(value)
    if (number !== undefined) return number
  }
  return undefined
}

function candidateObjects(...values: unknown[]): JsonRecord[] {
  return values.map(asRecord).filter((value) => Object.keys(value).length > 0)
}

function normalizeRechargeStatus(data: unknown, fallbackOutTradeNo: string): RechargeStatus {
  const root = asRecord(data)
  const dataPayload = asRecord(root.data)
  const payload = Object.keys(dataPayload).length ? dataPayload : root
  const candidates = candidateObjects(
    payload,
    payload.order,
    payload.payment,
    payload.payment_order,
    payload.order_info,
    payload.result,
    root,
  )
  const status = firstCleanValue(...candidates.flatMap((item) => [
    item.status,
    item.order_status,
    item.payment_status,
    item.pay_status,
    item.trade_status,
    item.alipay_trade_status,
    item.state,
  ])).toUpperCase()
  const paid = candidates.some((item) => item.is_paid === true || item.paid === true || item.completed === true)
  const paidAt = firstCleanValue(...candidates.flatMap((item) => [item.paid_at, item.paidAt]))
  const completedAt = firstCleanValue(...candidates.flatMap((item) => [item.completed_at, item.completedAt]))
  return {
    orderId: firstNumberValue(...candidates.flatMap((item) => [item.id, item.order_id, item.payment_order_id])),
    outTradeNo: firstCleanValue(...candidates.flatMap((item) => [item.out_trade_no, item.outTradeNo]), fallbackOutTradeNo),
    orderStatus: status || (paid || paidAt || completedAt ? 'PAID' : ''),
    amount: firstNumberValue(...candidates.flatMap((item) => [item.amount])),
    payAmount: firstNumberValue(...candidates.flatMap((item) => [item.pay_amount, item.payAmount, item.total_amount])),
    paidAt,
    completedAt,
  }
}

export {
  firstNumberValue,
  normalizeQrCode,
  normalizeRechargeErrorMessage,
  normalizeRechargeStatus,
}
