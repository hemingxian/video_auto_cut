import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../lib/className'

export type SelectOption = {
  label: string
  value: string
}

type SelectFieldProps = {
  value: string
  options: SelectOption[]
  placeholder?: string
  onChange: (value: string) => void
}

type MenuPosition = {
  direction: 'down' | 'up'
  left: number
  maxHeight: number
  top: number
  width: number
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

export function SelectField({ value, options, placeholder = '请选择', onChange }: SelectFieldProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const updateMenuPosition = useCallback(() => {
    const root = rootRef.current
    if (!root) return

    const rect = root.getBoundingClientRect()
    const margin = 12
    const gap = 8
    const width = Math.max(rect.width, 160)
    const left = clamp(rect.left, margin, window.innerWidth - width - margin)
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const direction = spaceBelow >= 180 || spaceBelow >= spaceAbove ? 'down' : 'up'
    const available = Math.max(direction === 'down' ? spaceBelow : spaceAbove, 120)
    const maxHeight = Math.min(320, available - gap)
    const top = direction === 'down'
      ? Math.min(rect.bottom + gap, window.innerHeight - margin)
      : Math.max(rect.top - gap, margin)

    setMenuPosition({
      direction,
      left,
      maxHeight,
      top,
      width,
    })
  }, [])

  useEffect(() => {
    if (!open) return

    const closeByClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeByKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    updateMenuPosition()
    window.addEventListener('mousedown', closeByClick)
    window.addEventListener('keydown', closeByKey)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('mousedown', closeByClick)
      window.removeEventListener('keydown', closeByKey)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, updateMenuPosition])

  useLayoutEffect(() => {
    if (!open) return
    updateMenuPosition()
  }, [open, options.length, updateMenuPosition])

  useEffect(() => {
    if (!open || !menuRef.current) return
    const option = menuRef.current.querySelector<HTMLElement>('[data-keyboard-active="true"]')
    option?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  function resetActiveIndex() {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }

  function openMenu() {
    resetActiveIndex()
    updateMenuPosition()
    setOpen(true)
  }

  function toggleMenu() {
    if (open) setOpen(false)
    else openMenu()
  }

  function choose(option: SelectOption) {
    onChange(option.value)
    setOpen(false)
  }

  function moveActive(step: number) {
    if (!options.length) return
    setOpen(true)
    setActiveIndex((current) => {
      const base = open ? current : selectedIndex >= 0 ? selectedIndex : step > 0 ? -1 : 0
      return (base + step + options.length) % options.length
    })
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open && options[activeIndex]) choose(options[activeIndex])
      else openMenu()
    }
  }

  const menu = open && menuPosition ? <div
    ref={menuRef}
    className={cx('select-menu', menuPosition.direction === 'up' && 'open-up')}
    role="listbox"
    style={{
      left: `${menuPosition.left}px`,
      maxHeight: `${menuPosition.maxHeight}px`,
      top: `${menuPosition.top}px`,
      width: `${menuPosition.width}px`,
    }}
  >
    {options.map((option, index) => {
      const active = option.value === value
      return <button
        key={option.value || '__empty'}
        type="button"
        role="option"
        aria-selected={active}
        className={cx('select-option', active && 'active', activeIndex === index && 'keyboard-active')}
        data-keyboard-active={activeIndex === index ? 'true' : undefined}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choose(option)}
      >
        <span>{option.label}</span>
        {active ? <Check className="select-check" /> : null}
      </button>
    })}
  </div> : null

  return <div ref={rootRef} className={cx('select-field', open && 'open')}>
    <button
      type="button"
      className="select-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={toggleMenu}
      onKeyDown={handleTriggerKeyDown}
    >
      <span className={cx(!selected && 'placeholder')}>{selected?.label || placeholder}</span>
      <ChevronDown className="select-chevron" />
    </button>

    {menu ? createPortal(menu, document.body) : null}
  </div>
}
