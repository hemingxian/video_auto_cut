import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type TooltipPlacement = 'top' | 'right' | 'bottom' | 'left'

type TooltipState = {
  placement: TooltipPlacement
  text: string
  x: number
  y: number
}

type TooltipPosition = {
  x: number
  y: number
}

type TooltipFootprint = {
  bottom: number
  left: number
  right: number
  top: number
}

const tooltipSelector = '[data-tooltip], [title]'
const interactiveSelector = 'button, a, input, select, textarea, [role="button"], [role="menuitem"], [tabindex]'
const tooltipFootprintByPlacement: Record<TooltipPlacement, (box: DOMRect) => TooltipFootprint> = {
  top: (box) => ({ left: box.width / 2, right: box.width / 2, top: box.height, bottom: 0 }),
  bottom: (box) => ({ left: box.width / 2, right: box.width / 2, top: 0, bottom: box.height }),
  left: (box) => ({ left: box.width, right: 0, top: box.height / 2, bottom: box.height / 2 }),
  right: (box) => ({ left: 0, right: box.width, top: box.height / 2, bottom: box.height / 2 }),
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function tooltipElementFrom(target: EventTarget | null) {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>(tooltipSelector)
}

function normalizeTooltipElement(element: HTMLElement) {
  const title = element.getAttribute('title')
  if (title) {
    element.dataset.tooltip = title
    element.dataset.tooltipNativeTitle = title
    element.removeAttribute('title')

    if (!element.getAttribute('aria-label') && element.matches(interactiveSelector)) {
      element.setAttribute('aria-label', title.replace(/\s+/g, ' ').trim())
    }
  }

  return (element.dataset.tooltip || '').trim()
}

function preferredPlacement(rect: DOMRect) {
  if (rect.left < 96 && window.innerWidth - rect.right > 220) return 'right'
  if (rect.top > 80) return 'top'
  if (window.innerHeight - rect.bottom > 80) return 'bottom'
  if (rect.left > 220) return 'left'
  return 'bottom'
}

function anchorPosition(rect: DOMRect, placement: TooltipPlacement) {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2

  if (placement === 'right') return { x: rect.right + 10, y: centerY }
  if (placement === 'left') return { x: rect.left - 10, y: centerY }
  if (placement === 'bottom') return { x: centerX, y: rect.bottom + 10 }
  return { x: centerX, y: rect.top - 10 }
}

function tooltipLines(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function AppTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const activeRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function hideTooltip() {
      activeRef.current = null
      setTooltip(null)
      setPosition(null)
    }

    function showTooltip(element: HTMLElement | null) {
      if (!element || !document.documentElement.contains(element)) return

      const text = normalizeTooltipElement(element)
      if (!text) {
        hideTooltip()
        return
      }

      const rect = element.getBoundingClientRect()
      const placement = preferredPlacement(rect)
      const anchor = anchorPosition(rect, placement)

      activeRef.current = element
      setPosition(null)
      setTooltip({
        placement,
        text,
        x: anchor.x,
        y: anchor.y,
      })
    }

    function handlePointerOver(event: PointerEvent) {
      const element = tooltipElementFrom(event.target)
      if (element === activeRef.current) return
      showTooltip(element)
    }

    function handlePointerOut(event: PointerEvent) {
      const active = activeRef.current
      if (!active) return

      const related = event.relatedTarget
      if (related instanceof Node && active.contains(related)) return
      if (event.target instanceof Node && active.contains(event.target)) hideTooltip()
    }

    function handleFocusIn(event: FocusEvent) {
      showTooltip(tooltipElementFrom(event.target))
    }

    function handleFocusOut(event: FocusEvent) {
      const active = activeRef.current
      if (!active) return

      const related = event.relatedTarget
      if (related instanceof Node && active.contains(related)) return
      hideTooltip()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') hideTooltip()
    }

    document.addEventListener('pointerover', handlePointerOver, true)
    document.addEventListener('pointerout', handlePointerOut, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('focusout', handleFocusOut, true)
    document.addEventListener('pointerdown', hideTooltip, true)
    document.addEventListener('scroll', hideTooltip, true)
    window.addEventListener('resize', hideTooltip)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerover', handlePointerOver, true)
      document.removeEventListener('pointerout', handlePointerOut, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('focusout', handleFocusOut, true)
      document.removeEventListener('pointerdown', hideTooltip, true)
      document.removeEventListener('scroll', hideTooltip, true)
      window.removeEventListener('resize', hideTooltip)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return

    const box = tooltipRef.current.getBoundingClientRect()
    const margin = 12
    const footprint = tooltipFootprintByPlacement[tooltip.placement](box)
    const x = clamp(tooltip.x, footprint.left + margin, window.innerWidth - footprint.right - margin)
    const y = clamp(tooltip.y, footprint.top + margin, window.innerHeight - footprint.bottom - margin)

    setPosition({ x: Math.round(x), y: Math.round(y) })
  }, [tooltip])

  if (!tooltip) return null

  const lines = tooltipLines(tooltip.text)
  const x = position?.x ?? tooltip.x
  const y = position?.y ?? tooltip.y

  return <div
    ref={tooltipRef}
    className={`app-tooltip is-${tooltip.placement}`}
    role="tooltip"
    style={{ left: `${x}px`, top: `${y}px` }}
  >
    {lines.map((line, index) => <span
      key={`${line}-${index}`}
      className={`app-tooltip-line${index === 0 && lines.length > 1 ? ' is-title' : ''}`}
    >
      {line}
    </span>)}
  </div>
}
