import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPlus, ClipboardCopy, Combine, ImagePlus, ListPlus, Pencil, Play, Rows3, Split, Trash2, X } from 'lucide-react'
import { chaptersPerFile, chaptersToText, fileStarts, formatTime, joinChapters, parseTime, setChapterStart, splitByFiles, timeline, type TimedChapter } from '../../../core/chapters.ts'
import { markChapterAtPlayer, removeSelection } from '../actions.ts'
import { clock } from '../format.ts'
import { useImageDrop, useSelection } from '../hooks.ts'
import { playFrom, usePlayer } from '../player.ts'
import { useStore } from '../store.ts'

function Thumb({ chapter }: { chapter: TimedChapter }) {
  const commit = useStore((s) => s.commit)
  const setImage = (image: string | undefined) =>
    commit((p) => ({ ...p, chapters: p.chapters.map((c) => (c.id === chapter.id ? { ...c, image } : c)) }))
  const { over, handlers } = useImageDrop((p) => setImage(p))
  const pick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const p = await window.api.pickImage()
    if (p) setImage(p)
  }
  return (
    <div className={`thumb ${chapter.image ? 'has' : ''} ${over ? 'over' : ''}`} {...handlers} title="Картинка главы: перетащите или нажмите" onClick={pick}>
      {chapter.image ? <img src={window.api.mediaUrl(chapter.image)} alt="" draggable={false} /> : <ImagePlus size={15} strokeWidth={1.6} />}
      {chapter.image && (
        <button
          className="x"
          title="Убрать картинку"
          onClick={(e) => {
            e.stopPropagation()
            setImage(undefined)
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

function StartInput({ chapter }: { chapter: TimedChapter }) {
  const commit = useStore((s) => s.commit)
  const shown = formatTime(chapter.start, chapter.start % 1 > 0.0005)
  const [draft, setDraft] = useState<string | null>(null)
  const bad = draft !== null && parseTime(draft) === undefined
  const apply = () => {
    if (draft === null) return
    const t = parseTime(draft)
    setDraft(null)
    if (t === undefined || Math.abs(t - chapter.start) < 0.0005) return
    commit((p) => ({ ...p, chapters: setChapterStart(p, chapter.id, t) }))
  }
  return (
    <input
      className={`cell-input time-input ${bad ? 'bad' : ''}`}
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(null)
      }}
      spellCheck={false}
      title="Начало главы (Ч:ММ:СС)"
    />
  )
}

const ChapterRow = memo(function ChapterRow(props: {
  chapter: TimedChapter
  selected: boolean
  current: boolean
  onSelect: (e: React.MouseEvent, id: string) => void
}) {
  const { chapter } = props
  const commit = useStore((s) => s.commit)
  return (
    <div
      className={`row chapters-grid ${props.selected ? 'sel' : ''} ${props.current ? 'current' : ''}`}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('input,button,.thumb')) return
        props.onSelect(e, chapter.id)
      }}
    >
      <div className="num">{chapter.index + 1}</div>
      <Thumb chapter={chapter} />
      <input
        className="cell-input"
        data-chapter-title={chapter.id}
        value={chapter.title}
        placeholder="Без названия"
        onChange={(e) => {
          const title = e.target.value
          commit((p) => ({ ...p, chapters: p.chapters.map((c) => (c.id === chapter.id ? { ...c, title } : c)) }), `ch.${chapter.id}`)
        }}
        onFocus={(e) => !props.selected && props.onSelect(e as unknown as React.MouseEvent, chapter.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
            const next = document.querySelectorAll<HTMLInputElement>('[data-chapter-title]')
            const i = [...next].findIndex((x) => x.dataset.chapterTitle === chapter.id)
            if (next[i + 1]) {
              e.preventDefault()
              next[i + 1].focus()
              next[i + 1].select()
            } else if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }
        }}
        spellCheck={false}
      />
      <StartInput chapter={chapter} />
      <div className="time">{clock(chapter.duration)}</div>
      <button className="icon-btn play" title="Слушать с начала главы" onClick={() => playFrom(chapter.start)}>
        <Play size={15} />
      </button>
    </div>
  )
})

export function ChaptersToolbar() {
  const project = useStore((s) => s.project)
  const sel = useStore((s) => s.selChapters)
  const commit = useStore((s) => s.commit)
  const set = useStore((s) => s.set)
  const tl = useMemo(() => timeline(project), [project])
  const selected = tl.filter((c) => sel.includes(c.id))
  const starts = useMemo(() => fileStarts(project.files), [project.files])
  const canSplit = selected.some((c) => [...starts.values()].some((s) => s > c.start + 0.001 && s < c.end - 0.001))
  const copy = async () => {
    await navigator.clipboard.writeText(chaptersToText(project))
    useStore.getState().toast('success', 'Список глав скопирован', 'Формат: «Ч:ММ:СС.мс Название» — его же можно вставить обратно')
  }
  const perFile = async () => {
    const r = await window.api.confirm('Пересоздать главы по файлам?', 'Текущие главы будут заменены: каждая часть-файл станет главой.', ['Пересоздать', 'Отмена'])
    if (r === 0) commit((p) => ({ ...p, chapters: chaptersPerFile(p.files) }))
  }
  return (
    <div className="toolbar">
      <button className="btn ghost" onClick={markChapterAtPlayer} title="Новая глава в текущей позиции плеера (⌘M)">
        <BookmarkPlus size={15} /> Глава здесь
      </button>
      <span className="sep" />
      <button className="btn ghost" disabled={selected.length < 2} onClick={() => commit((p) => ({ ...p, chapters: joinChapters(p, sel) }))} title="Объединить выбранные соседние главы">
        <Combine size={15} /> Объединить
      </button>
      <button className="btn ghost" disabled={!canSplit} onClick={() => commit((p) => ({ ...p, chapters: splitByFiles(p, sel) }))} title="Разбить выбранные главы по границам файлов">
        <Split size={15} /> Разделить
      </button>
      <button className="btn ghost" disabled={!tl.length} onClick={() => set({ dialog: 'rename' })} title="Переименовать по шаблону: «Глава 1», «Глава 2»…">
        <Pencil size={15} /> Переименовать
      </button>
      <span className="sep" />
      <button className="btn ghost" disabled={!project.files.length} onClick={() => set({ dialog: 'list' })} title="Вставить список таймкодов или названий">
        <ListPlus size={15} /> Вставить список
      </button>
      <button className="icon-btn" disabled={!tl.length} onClick={copy} title="Скопировать список глав">
        <ClipboardCopy size={16} />
      </button>
      <button className="icon-btn" disabled={!project.files.length} onClick={perFile} title="Пересоздать: по главе на файл">
        <Rows3 size={16} />
      </button>
      <button className="icon-btn" disabled={!sel.length} onClick={removeSelection} title="Удалить выбранные главы (Delete)">
        <Trash2 size={16} />
      </button>
    </div>
  )
}

export function ChaptersView() {
  const project = useStore((s) => s.project)
  const sel = useStore((s) => s.selChapters)
  const editChapter = useStore((s) => s.editChapter)
  const set = useStore((s) => s.set)
  const tl = useMemo(() => timeline(project), [project])
  const order = useMemo(() => tl.map((c) => c.id), [tl])
  const onSelect = useSelection(order, sel, (ids) => set({ selChapters: ids }))
  const time = usePlayer((s) => s.time)
  const currentId = [...tl].reverse().find((c) => c.start <= time + 0.01)?.id
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editChapter) return
    const el = document.querySelector<HTMLInputElement>(`[data-chapter-title="${editChapter}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    el?.focus()
    el?.select()
    set({ editChapter: undefined })
  }, [editChapter, set])

  if (!tl.length) {
    return (
      <div className="empty">
        <div className="note" style={{ maxWidth: 420, textAlign: 'center' }}>
          Глав пока нет. Нажмите «Глава здесь» во время прослушивания, вставьте список таймкодов или пересоздайте главы по файлам.
        </div>
      </div>
    )
  }
  return (
    <div className="list" ref={listRef} tabIndex={-1} onMouseDown={(e) => e.target === listRef.current && set({ selChapters: [] })}>
      <div className="list-head chapters-grid">
        <div className="num">№</div>
        <div />
        <div>Название</div>
        <div style={{ textAlign: 'right' }}>Начало</div>
        <div style={{ textAlign: 'right' }}>Длина</div>
        <div />
      </div>
      {tl.map((c) => (
        <ChapterRow key={c.id} chapter={c} selected={sel.includes(c.id)} current={c.id === currentId} onSelect={onSelect} />
      ))}
    </div>
  )
}
