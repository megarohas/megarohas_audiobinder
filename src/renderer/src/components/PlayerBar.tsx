import { useMemo, useRef } from 'react'
import { BookmarkPlus, Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { timeline, totalDuration } from '../../../core/chapters.ts'
import { markChapterAtPlayer } from '../actions.ts'
import { clock } from '../format.ts'
import { seek, skip, toggle, usePlayer } from '../player.ts'
import { useStore } from '../store.ts'

export function PlayerBar() {
  const project = useStore((s) => s.project)
  const { playing, time } = usePlayer()
  const total = useMemo(() => totalDuration(project.files), [project.files])
  const tl = useMemo(() => timeline(project), [project])
  const current = [...tl].reverse().find((c) => c.start <= time + 0.01)
  const trackRef = useRef<HTMLDivElement>(null)
  const empty = !project.files.length

  const seekFromEvent = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    seek(((clientX - r.left) / r.width) * total)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (empty) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    seekFromEvent(e.clientX)
  }
  const pct = total ? (time / total) * 100 : 0

  return (
    <div className="player">
      <div className="inline" style={{ gap: 4 }}>
        <button className="icon-btn" disabled={empty} onClick={() => skip(-15)} title="Назад 15 с">
          <RotateCcw size={16} />
        </button>
        <button className="play-btn" disabled={empty} onClick={toggle} title="Пуск / пауза (Пробел)">
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <button className="icon-btn" disabled={empty} onClick={() => skip(15)} title="Вперёд 15 с">
          <RotateCw size={16} />
        </button>
      </div>
      <div className="time start" style={{ minWidth: 64 }}>{clock(time)}</div>
      <div className="scrub">
        <div className="meta">
          <span className="ch">{current ? `${current.index + 1}. ${current.title}` : empty ? 'Добавьте файлы, чтобы слушать' : ''}</span>
        </div>
        <div
          className="track"
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => e.buttons === 1 && !empty && seekFromEvent(e.clientX)}
        >
          <div className="rail" />
          <div className="fill" style={{ width: `${pct}%` }} />
          {total > 0 && tl.slice(1).map((c) => <div key={c.id} className="tick" style={{ left: `${(c.start / total) * 100}%` }} title={c.title} />)}
          {!empty && <div className="knob" style={{ left: `${pct}%` }} />}
        </div>
      </div>
      <div className="time" style={{ minWidth: 64, textAlign: 'left' }}>{clock(total)}</div>
      <button className="btn" disabled={empty} onClick={markChapterAtPlayer} title="Новая глава в этой позиции (⌘M)">
        <BookmarkPlus size={15} /> Глава
      </button>
    </div>
  )
}
