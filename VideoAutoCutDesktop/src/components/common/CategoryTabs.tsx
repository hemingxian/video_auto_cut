import { cx } from '../../lib/className'

export type CategoryTabItem<T extends string> = {
  id: T
  label: string
  count?: number
}

export function CategoryTabs<T extends string>({
  items,
  active,
  onChange,
  className,
}: {
  items: CategoryTabItem<T>[]
  active?: T
  onChange: (id: T) => void
  className?: string
}) {
  return <div className={cx('category-tabs', className)}>
    {items.map((item) => <button
      key={item.id}
      type="button"
      className={cx('category-tab', active === item.id && 'active')}
      onClick={() => onChange(item.id)}
    >
      {item.label}
      {typeof item.count === 'number' ? <span>{item.count}</span> : null}
    </button>)}
  </div>
}

