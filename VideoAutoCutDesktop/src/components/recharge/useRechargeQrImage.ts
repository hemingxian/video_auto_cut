import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

import { deferToNextTick } from '../../lib/defer'

export function useRechargeQrImage(qrCode?: string) {
  const [qrImage, setQrImage] = useState('')
  const [qrError, setQrError] = useState<{ qrCode?: string; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const value = qrCode?.trim()

    if (!value) {
      return deferToNextTick(() => setQrImage(''))
    }

    if (/^data:image\//i.test(value)) {
      return deferToNextTick(() => setQrImage(value))
    }

    QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 190,
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    }).then((dataUrl) => {
      if (!cancelled) setQrImage(dataUrl)
    }).catch(() => {
      if (!cancelled) setQrError({ qrCode: value, message: '支付二维码生成失败，请稍后重试' })
    })

    return () => {
      cancelled = true
    }
  }, [qrCode])

  const activeError = qrError?.qrCode === qrCode?.trim() ? qrError : null
  return { qrImage, qrError: activeError?.message || '' }
}
