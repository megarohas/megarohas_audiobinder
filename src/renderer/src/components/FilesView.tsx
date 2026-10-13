import { memo, useMemo, useRef } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownAZ, Bookmark, FilePlus2, FolderPlus, GripVertical, Trash2 } from 'lucide-react'
import { fileStarts } from '../../../core/chapters.ts'
import { naturalSort } from '../sort.ts'
import { pickAndAdd, removeSelection } from '../actions.ts'
import { clock, fileFormat } from '../format.ts'
import { useSelection } from '../hooks.ts'
import { useStore } from '../store.ts'
import type { SourceFile } from '../../../core/types.ts'

const FileRow = memo(function FileRow(props: {
  file: SourceFile
  index: number
  start: number
  chapters: number
  selected: boolean
  missing: boolean
  onSelect: (e: React.MouseEvent, id: string) => void
}) {
  const { file } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: file.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 5 : undefined, position: 'relative', opacity: isDragging ? 0.85 : 1 }}
      className={`row files-grid ${props.selected ? 'sel' : ''} ${props.missing ? 'missing' : ''}`}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.handle')) return
        props.onSelect(e, file.id)
      }}
      title={file.path}
    >
      <div className="handle" {...attributes} {...listeners} title="Перетащите, чтобы изменить порядок">
        <GripVertical size={15} />
      </div>
      <div className="num">{props.index + 1}</div>
      <div className="name">
        {file.name}
        {props.chapters > 1 && (
          <span className="badge" title="Глав внутри файла">
            <Bookmark size={10} /> {props.chapters}
          </span>
        )}
        {props.missing && <span className="sub"> — файл не найден</span>}
      </div>
      <div className="sub">{fileFormat(file)}</div>
      <div className="time start">{clock(props.start)}</div>
      <div className="time">{clock(file.duration)}</div>
    </div>
  )
})

export function FilesToolbar() {
  const commit = useStore((s) => s.commit)
  const sel = useStore((s) => s.selFiles)
  const hasFiles = useStore((s) => s.project.files.length > 0)
  const sortByName = () =>
    commit((p) => ({ ...p, files: naturalSort(p.files, (f) => f.path) }))
  return (
    <div className="toolbar">
      <button className="btn ghost" onClick={() => pickAndAdd('files')}>
        <FilePlus2 size={15} /> Файлы
      </button>
      <button className="btn ghost" onClick={() => pickAndAdd('folder')}>
        <FolderPlus size={15} /> Папка
      </button>
      <span className="sep" />
      <button className="btn ghost" disabled={!hasFiles} onClick={sortByName} title="Упорядочить по имени файла (1, 2, … 10)">
        <ArrowDownAZ size={15} /> По имени
      </button>
      <button className="icon-btn" disabled={!sel.length} onClick={removeSelection} title="Убрать выбранные файлы (Delete)">
        <Trash2 size={16} />
      </button>
    </div>
  )
}

export function FilesView() {
  const files = useStore((s) => s.project.files)
  const chapters = useStore((s) => s.project.chapters)
  const missing = useStore((s) => s.missing)
  const sel = useStore((s) => s.selFiles)
  const set = useStore((s) => s.set)
  const commit = useStore((s) => s.commit)
  const order = useMemo(() => files.map((f) => f.id), [files])
  const starts = useMemo(() => fileStarts(files), [files])
  const perFile = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of chapters) m.set(c.fileId, (m.get(c.fileId) ?? 0) + 1)
    return m
  }, [chapters])
  const onSelect = useSelection(order, sel, (ids) => set({ selFiles: ids }))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const listRef = useRef<HTMLDivElement>(null)

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = order.indexOf(String(e.active.id))
    const to = order.indexOf(String(e.over.id))
    commit((p) => ({ ...p, files: arrayMove(p.files, from, to) }))
  }

  return (
    <div className="list" ref={listRef} tabIndex={-1} onMouseDown={(e) => e.target === listRef.current && set({ selFiles: [] })}>
      <div className="list-head files-grid">
        <div />
        <div className="num">№</div>
        <div>Файл</div>
        <div>Формат</div>
        <div style={{ textAlign: 'right' }}>Начало</div>
        <div style={{ textAlign: 'right' }}>Длина</div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          {files.map((f, i) => (
            <FileRow
              key={f.id}
              file={f}
              index={i}
              start={starts.get(f.id) ?? 0}
              chapters={perFile.get(f.id) ?? 0}
              selected={sel.includes(f.id)}
              missing={missing.includes(f.path)}
              onSelect={onSelect}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  )
}
