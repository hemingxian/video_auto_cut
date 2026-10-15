import { AnimatePresence, motion } from 'framer-motion'
import type { ReactNode } from 'react'

export function SideDrawer({
  open,
  className = '',
  panelClassName = '',
  onClose,
  children,
}: {
  open: boolean
  className?: string
  panelClassName?: string
  onClose: () => void
  children: ReactNode
}) {
  return <AnimatePresence>
    {open ? <motion.div
      className={`side-drawer-overlay ${className}`.trim()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <motion.aside
        className={`side-drawer-panel ${panelClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        initial={{ x: 28, opacity: 0.72 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 30, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      >
        {children}
      </motion.aside>
    </motion.div> : null}
  </AnimatePresence>
}