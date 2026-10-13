import { useMemo } from 'react'
import { AlertTriangle, CheckCircle2, FolderOpen, Hammer, Loader2, PlayCircle, Settings2 } from 'lucide-react'
import { timeline, totalDuration } from '../../../core/chapters.ts'
import { estimateBytes, passthroughCheck, planParts } from '../../../core/plan.ts'
import { startBuild } from '../actions.ts'
import { bytes, humanDuration, partsLabel, plural, qualityLabel } from '../format.ts'
import { useStore } from '../store.ts'
import { Modal } from './Modal.tsx'

export function BuildBar() {
  const project = useStore((s) => s.project)
  const set = useStore((s) => s.set)
  const running = useStore((s) => s.build.running)
  const o = project.build
  const info = useMemo(() => {
    const total = totalDuration(project.files)
    const pass = o.passthrough && passthroughCheck(project, o).ok
    return {
      total,
      chapters: timeline(project).length,
      parts: planParts(project, o).length,
      pass,
      size: estimateBytes(project, o),
    }
  }, [project, o])
  const empty = !project.files.length

  return (
    <div className="buildbar">
      <div className="summary">
        <span className="chip">
          <b>{o.format.toUpperCase()}</b> {o.format === 'm4b' ? 'аудиокнига' : 'музыка'}
        </span>
        <span className="chip">{info.pass ? <b>без перекодирования</b> : qualityLabel(o)}</span>
        <span className="chip">{info.parts > 1 ? `${info.parts} ${plural(info.parts, 'файл', 'файла', 'файлов')} · ${partsLabel(o)}` : 'одним файлом'}</span>
        {!empty && (
          <>
            <span className="chip">
              <b>{humanDuration(info.total)}</b>
            </span>
            <span className="chip">
              {info.chapters} {plural(info.chapters, 'глава', 'главы', 'глав')}
            </span>
            <span className="chip">≈ {bytes(info.size)}</span>
          </>
        )}
      </div>
      <button className="btn" onClick={() => set({ dialog: 'buildOptions' })}>
        <Settings2 size={15} /> Параметры
      </button>
      <button className="btn primary big" disabled={empty || running} onClick={startBuild}>
        <Hammer size={16} /> Собрать
      </button>
    </div>
  )
}

const STAGES: Record<string, string> = {
  prepare: 'Подготовка',
  encode: 'Кодирование',
  mux: 'Главы',
  finalize: 'Теги и обложка',
  done: 'Готово',
}

function eta(s?: number): string {
  if (s === undefined || !isFinite(s)) return 'оцениваю время…'
  if (s < 60) return 'меньше минуты'
  return `осталось ~${humanDuration(Math.round(s / 60) * 60)}`
}

export function BuildOverlay() {
  const build = useStore((s) => s.build)
  const set = useStore((s) => s.set)
  if (!build.running && !build.result && !build.error) return null
  const close = () => set({ build: { running: false } })

  if (build.running) {
    const p = build.progress
    const pct = Math.round((p?.fraction ?? 0) * 1000) / 10
    return (
      <Modal title="Сборка аудиокниги" width={500}>
        <div className="progress-card">
          <div className="row-line">
            <span>
              <Loader2 size={13} className="spin" style={{ verticalAlign: -2, marginRight: 6 }} />
              {p ? STAGES[p.stage] : 'Запуск'}
              {p && p.parts > 1 ? ` · часть ${p.part} из ${p.parts}` : ''}
            </span>
            <span className="mono">{pct.toFixed(1)}%</span>
          </div>
          <div className="bar">
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="row-line">
            <span className="name">{p?.message ?? ''}</span>
            <span>{eta(p?.etaSeconds)}</span>
          </div>
        </div>
        <footer>
          <button className="btn" onClick={() => window.api.cancelBuild()}>
            Отменить
          </button>
        </footer>
      </Modal>
    )
  }

  if (build.error) {
    return (
      <Modal title="Сборка не удалась" width={540} onClose={close}>
        <div className="content">
          <div className="result-icon err">
            <AlertTriangle size={26} />
          </div>
          <pre className="err">{build.error}</pre>
        </div>
        <footer>
          <button className="btn primary" onClick={close}>
            Понятно
          </button>
        </footer>
      </Modal>
    )
  }

  const r = build.result!
  return (
    <Modal title="Аудиокнига готова" width={540} onClose={close}>
      <div className="content">
        <div className="inline" style={{ gap: 14 }}>
          <div className="result-icon">
            <CheckCircle2 size={26} />
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>
              {r.outputs.length === 1 ? 'Файл записан' : `Записано файлов: ${r.outputs.length}`}
            </div>
            <div className="sub">
              {r.seconds < 1 ? 'меньше чем за секунду' : `за ${humanDuration(r.seconds)}`}
              {r.passthrough ? ' · без перекодирования' : ''}
            </div>
          </div>
        </div>
        <div className="outputs">
          {r.outputs.map((f) => (
            <button key={f} onClick={() => window.api.reveal(f)} title="Показать в папке">
              {f.split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
      </div>
      <footer>
        <button className="btn left" onClick={() => window.api.openPath(r.outputs[0])}>
          <PlayCircle size={15} /> Открыть
        </button>
        <button className="btn" onClick={() => window.api.reveal(r.outputs[0])}>
          <FolderOpen size={15} /> Показать в папке
        </button>
        <button className="btn primary" onClick={close}>
          Готово
        </button>
      </footer>
    </Modal>
  )
}
