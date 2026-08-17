import type { ReactNode } from 'react'
import { useEffect } from 'react'

interface Props {
  title?: string
  onClose: () => void
  children: ReactNode
}

/** Bottom sheet: reachable one-handed, and dismissed by tapping away. */
export function Sheet({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="sheet-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="grabber" />
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  )
}
