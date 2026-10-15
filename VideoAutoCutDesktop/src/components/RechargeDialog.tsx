import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RechargeResult } from '../types/videoauto'
import './RechargeDialog.css'
import { RechargeFormView } from './recharge/RechargeFormView'
import { RechargeHeader } from './recharge/RechargeHeader'
import { RechargeQrView } from './recharge/RechargeQrView'
import { useRechargePolling } from './recharge/useRechargePolling'
import { useRechargeQrImage } from './recharge/useRechargeQrImage'
import { deferToNextTick } from '../lib/defer'

export function RechargeDialog({
  open,
  onClose,
  onPaid,
}: {
  open: boolean
  onClose: () => void
  onPaid: () => void
}) {
  const [amount, setAmount] = useState(10)
  const [customAmount, setCustomAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<RechargeResult | null>(null)
  const [confirmingPaid, setConfirmingPaid] = useState(false)
  const { qrImage, qrError } = useRechargeQrImage(result?.qrCode)
  const finalAmount = Number(customAmount || amount)
  const showingQrCode = Boolean(result?.qrCode)
  const displayError = useMemo(() => qrError || error, [error, qrError])

  const resetPaymentState = useCallback(() => {
    setLoading(false)
    setError('')
    setResult(null)
    setConfirmingPaid(false)
  }, [])

  useEffect(() => {
    if (open) return
    return deferToNextTick(resetPaymentState)
  }, [open, resetPaymentState])

  useRechargePolling({
    result,
    onPaid,
    onError: setError,
    onClearError: () => setError(''),
  })

  if (!open) return null

  async function submit() {
    if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
      setError('请输入有效充值金额')
      return
    }

    setLoading(true)
    setError('')
    setResult(null)
    try {
      const response = await window.videoAutoCut.authRecharge({ amount: finalAmount })
      if (!response.ok) {
        setError(response.message || '支付失败')
        return
      }
      setResult(response)
      if (!response.qrCode) setError(response.message || '支付通道未返回支付二维码')
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error))
    } finally {
      setLoading(false)
    }
  }

  function choosePreset(value: number) {
    setAmount(value)
    setCustomAmount('')
    setError('')
    setResult(null)
  }

  function closeDialog() {
    resetPaymentState()
    onClose()
  }

  async function confirmPaid() {
    setConfirmingPaid(true)
    try {
      const refreshed = await window.videoAutoCut.authRefresh()
      if (refreshed.ok) {
        onPaid()
        return
      }
      setError(refreshed.message || '余额刷新失败，请稍后重试')
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error))
    } finally {
      setConfirmingPaid(false)
    }
  }

  return <div className="recharge-overlay">
    <div className="recharge-dialog">
      <RechargeHeader showingQrCode={showingQrCode} onClose={closeDialog} />

      <div className="recharge-body">
        {showingQrCode ? <RechargeQrView
          amount={result?.payAmount || finalAmount}
          error={displayError}
          qrImage={qrImage}
          confirmingPaid={confirmingPaid}
          onBack={resetPaymentState}
          onConfirmPaid={confirmPaid}
        /> : <RechargeFormView
          amount={amount}
          customAmount={customAmount}
          error={error}
          finalAmount={finalAmount}
          loading={loading}
          onPresetChange={choosePreset}
          onCustomAmountChange={(value) => {
            setCustomAmount(value)
            setResult(null)
          }}
          onSubmit={submit}
        />}
      </div>
    </div>
  </div>
}
