import { CloseButton } from '../common/CloseButton'

export function RechargeHeader({ showingQrCode, onClose }: { showingQrCode: boolean; onClose: () => void }) {
  return <div className="recharge-head">
    <div>
      <strong>充值余额</strong>
      <span>{showingQrCode ? '请使用支付宝扫码完成支付。' : '选择金额后完成支付。'}</span>
    </div>
    <CloseButton onClick={onClose} />
  </div>
}
