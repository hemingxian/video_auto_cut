export function RechargeQrView({
  amount,
  error,
  qrImage,
  confirmingPaid,
  onBack,
  onConfirmPaid,
}: {
  amount: number
  error: string
  qrImage: string
  confirmingPaid: boolean
  onBack: () => void
  onConfirmPaid: () => void
}) {
  return <div className="recharge-qr-state">
    {qrImage ? <div className="recharge-qr-wrap" aria-live="polite">
      <img className="recharge-qr-image" src={qrImage} alt="支付宝支付二维码" />
    </div> : <div className="recharge-qr-loading">二维码生成中...</div>}
    <div className="recharge-pay-meta">
      <strong>¥{amount}</strong>
      <span>支付宝扫码支付</span>
    </div>
    {error ? <div className="recharge-error">{error}</div> : null}
    <div className="recharge-qr-actions">
      <button type="button" className="button" onClick={onBack}>返回修改金额</button>
      <button type="button" className="button primary" onClick={onConfirmPaid} disabled={confirmingPaid}>已支付</button>
    </div>
  </div>
}
