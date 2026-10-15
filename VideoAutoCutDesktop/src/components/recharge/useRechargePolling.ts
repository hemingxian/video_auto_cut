import { useEffect } from 'react'
import type { RechargeResult } from '../../types/videoauto'
import { isPaidStatus, isPendingStatus, isTerminalFailedStatus, normalizePaymentStatus, paymentFailedMessage } from './rechargeState'

interface PaymentPollingOptions {
  result: RechargeResult | null
  onPaid: () => void
  onError: (message: string) => void
  onClearError: () => void
}

export function useRechargePolling({ result, onPaid, onError, onClearError }: PaymentPollingOptions) {
  useEffect(() => {
    const outTradeNo = result?.outTradeNo
    if (!result?.qrCode || !outTradeNo) return
    const pollOutTradeNo = outTradeNo

    let cancelled = false
    let timeoutId: number | undefined

    async function poll() {
      if (cancelled) return
      try {
        const statusResult = await window.videoAutoCut.authRechargeStatus({ outTradeNo: pollOutTradeNo })
        if (cancelled) return

        if (!statusResult.ok) {
          timeoutId = window.setTimeout(poll, 3000)
          return
        }

        onClearError()
        const nextStatus = normalizePaymentStatus(statusResult.orderStatus)

        if (isPaidStatus(statusResult)) {
          const refreshed = await window.videoAutoCut.authRefresh()
          if (!cancelled && refreshed.ok) onPaid()
          return
        }

        if (isTerminalFailedStatus(nextStatus)) {
          onError(paymentFailedMessage(nextStatus))
          return
        }

        if (!isPendingStatus(nextStatus)) onError(`未知支付状态：${nextStatus}`)
        timeoutId = window.setTimeout(poll, 3000)
      } catch {
        if (cancelled) return
        timeoutId = window.setTimeout(poll, 3000)
      }
    }

    timeoutId = window.setTimeout(poll, 1200)

    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [result?.qrCode, result?.outTradeNo, onPaid, onClearError, onError])
}
