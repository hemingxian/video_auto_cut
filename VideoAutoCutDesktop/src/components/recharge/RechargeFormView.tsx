import alipayIcon from '../../assets/alipay.png'
import { cx } from '../../lib/className'
import { PRESET_AMOUNTS } from './rechargeState'

export function RechargeFormView({
  amount,
  customAmount,
  error,
  finalAmount,
  loading,
  onPresetChange,
  onCustomAmountChange,
  onSubmit,
}: {
  amount: number
  customAmount: string
  error: string
  finalAmount: number
  loading: boolean
  onPresetChange: (amount: number) => void
  onCustomAmountChange: (amount: string) => void
  onSubmit: () => void
}) {
  return <>
    <div className="recharge-amount-grid">
      {PRESET_AMOUNTS.map((value) => <button
        key={value}
        type="button"
        className={cx('recharge-amount', !customAmount && amount === value && 'active')}
        onClick={() => onPresetChange(value)}
      >
        ¥{value}
      </button>)}
    </div>

    <div className="recharge-method-section">
      <span className="recharge-section-label">支付方式</span>
      <div className="recharge-method-options">
        <button type="button" className="recharge-method-card active" aria-pressed="true">
          <span className="recharge-alipay-icon-wrap" aria-hidden="true">
            <img className="recharge-alipay-icon" src={alipayIcon} alt="" />
          </span>
          <span className="recharge-method-name">支付宝</span>
        </button>
      </div>
    </div>

    <label className="recharge-custom">
      <span>自定义金额</span>
      <input
        type="number"
        min="1"
        value={customAmount}
        placeholder="输入充值金额"
        onChange={(event) => onCustomAmountChange(event.target.value)}
      />
    </label>

    <button className="button primary recharge-submit" type="button" disabled={loading} onClick={onSubmit}>
      {loading ? '处理中...' : `支付 ¥${finalAmount || 0}`}
    </button>

    {error ? <div className="recharge-error">{error}</div> : null}
  </>
}
