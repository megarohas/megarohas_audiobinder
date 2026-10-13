import { useCallback, useState, type DragEvent, type MouseEvent } from 'react'

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|tiff?)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p)
}

export function droppedPaths(e: DragEvent): string[] {
  return [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
}

/** Drop target that accepts a single image file. */
export function useImageDrop(onImage: (path: string) => void) {
  const [over, setOver] = useState(false)
  const onDragOver = useCallback((e: DragEvent) => {
    if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
    e.preventDefault()
    e.stopPropagation()
    setOver(true)
  }, [])
  const onDragLeave = useCallback(() => setOver(false), [])
  const onDrop = useCallback(
    (e: DragEvent) => {
      setOver(false)
      const img = droppedPaths(e).find(isImagePath)
      if (!img) return
      e.preventDefault()
      e.stopPropagation()
      onImage(img)
    },
    [onImage],
  )
  return { over, handlers: { onDragOver, onDragLeave, onDrop } }
}

/** Finder-style selection: click, Cmd/Ctrl+click toggles, Shift+click extends. */
export function useSelection(order: string[], selected: string[], setSelected: (ids: string[]) => void) {
  const [anchor, setAnchor] = useState<string | undefined>()
  return useCallback(
    (e: MouseEvent, id: string) => {
      if (e.shiftKey && anchor && order.includes(anchor)) {
        const a = order.indexOf(anchor)
        const b = order.indexOf(id)
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
        setSelected(e.metaKey || e.ctrlKey ? [...new Set([...selected, ...range])] : range)
        return
      }
      if (e.metaKey || e.ctrlKey) {
        setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
      } else if (!(selected.length === 1 && selected[0] === id)) {
        setSelected([id])
      }
      setAnchor(id)
    },
    [anchor, order, selected, setSelected],
  )
}

export function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}
