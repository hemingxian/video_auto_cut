import { formatCurrency } from '../../lib/format'

export function formatBalance(value: number | undefined) {
  return formatCurrency(value, '')
}
