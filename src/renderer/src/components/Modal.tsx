import { useEffect, type ReactNode } from 'react'

export function Modal(props: { title: string; subtitle?: string; width?: number; onClose?: () => void; children: ReactNode }) {
  const { onClose } = props
  useEffect(() => {
    if (!onClose) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ '--w': `${props.width ?? 560}px` } as React.CSSProperties} role="dialog" aria-label={props.title}>
        <header>
          <h3>{props.title}</h3>
          {props.subtitle && <p>{props.subtitle}</p>}
        </header>
        {props.children}
      </div>
    </div>
  )
}
