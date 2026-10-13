import { useMemo, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { applyChapterList, formatTime, parseChapterList, RENAME_PRESETS, renameChapters, renderName, timeline } from '../../../core/chapters.ts'
import { passthroughCheck } from '../../../core/plan.ts'
import { QUALITY_PRESETS, type BuildOptions, type PartsMode, type QualityPreset, type TagTarget } from '../../../core/types.ts'
import { khz, PRESET_LABEL } from '../format.ts'
import { useStore } from '../store.ts'
import { Modal } from './Modal.tsx'

// ------------------------------------------------------------ rename

export function RenameDialog() {
  const project = useStore((s) => s.project)
  const sel = useStore((s) => s.selChapters)
  const commit = useStore((s) => s.commit)
  const set = useStore((s) => s.set)
  const close = () => set({ dialog: null })
  const tl = useMemo(() => timeline(project), [project])
  const targets = sel.length > 1 ? tl.filter((c) => sel.includes(c.id)) : tl
  const [template, setTemplate] = useState('Глава {n}')
  const [start, setStart] = useState(1)
  const [padOn, setPadOn] = useState(false)
  const [pad, setPad] = useState(String(targets.length).length)
  const inputRef = useRef<HTMLInputElement>(null)
  const opts = { template, start, pad: padOn ? pad : 0, bookTitle: project.meta.title }

  const insert = (token: string) => {
    const el = inputRef.current!
    const a = el.selectionStart ?? template.length
    const b = el.selectionEnd ?? template.length
    setTemplate(template.slice(0, a) + token + template.slice(b))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(a + token.length, a + token.length)
    })
  }
  const apply = () => {
    commit((p) => ({ ...p, chapters: renameChapters(p, targets.map((c) => c.id), opts) }))
    close()
  }

  return (
    <Modal title="Переименовать главы" subtitle={sel.length > 1 ? `Выбрано глав: ${targets.length}` : `Все главы: ${targets.length}`} onClose={close}>
      <div className="content">
        <div className="field">
          <span>Шаблон</span>
          <div className="inline" style={{ flexWrap: 'nowrap' }}>
            <input ref={inputRef} className="input" value={template} onChange={(e) => setTemplate(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && apply()} />
            <select className="select" style={{ width: 180 }} value="" onChange={(e) => e.target.value && setTemplate(e.target.value)}>
              <option value="">Готовые…</option>
              {RENAME_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="inline">
          <button className="token" onClick={() => insert('{n}')}>Номер</button>
          <button className="token" onClick={() => insert('{N}')}>Всего глав</button>
          <button className="token" onClick={() => insert('{name}')}>Текущее название</button>
          <button className="token" onClick={() => insert('{title}')}>Название книги</button>
        </div>
        <div className="inline" style={{ gap: 18 }}>
          <label className="inline">
            Нумерация с
            <input className="input" style={{ width: 70 }} type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value) || 0)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={padOn} onChange={(e) => setPadOn(e.target.checked)} />
            Ведущие нули, цифр:
            <input className="input" style={{ width: 60 }} type="number" min={1} max={6} disabled={!padOn} value={pad} onChange={(e) => setPad(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        </div>
        <div className="examples">
          {targets.slice(0, 4).map((c, i) => (
            <div key={c.id}>{renderName(opts, i, targets.length, c.title) || <span className="sub">(пусто)</span>}</div>
          ))}
          {targets.length > 4 && <div className="sub">… и ещё {targets.length - 4}</div>}
        </div>
      </div>
      <footer>
        <button className="btn" onClick={close}>Отмена</button>
        <button className="btn primary" onClick={apply}>Переименовать</button>
      </footer>
    </Modal>
  )
}

// ------------------------------------------------------------ chapter list

const LIST_EXAMPLE = `0:00 Пролог
12:31 Глава 1. Ведьмак
1:05:10 Глава 2. Голос рассудка`

export function ChapterListDialog() {
  const project = useStore((s) => s.project)
  const commit = useStore((s) => s.commit)
  const set = useStore((s) => s.set)
  const close = () => set({ dialog: null })
  const [text, setText] = useState('')
  const parsed = useMemo(() => parseChapterList(text), [text])
  const result = useMemo(() => (parsed.entries.length ? applyChapterList(project, parsed) : undefined), [parsed, project])
  const count = timeline(project).length
  const apply = () => {
    if (!result) return
    commit((p) => ({ ...p, chapters: result.chapters }))
    for (const w of result.warnings) useStore.getState().toast('info', w)
    close()
  }
  return (
    <Modal title="Вставить список глав" subtitle="С таймкодами — главы будут заменены. Только названия — переименуют текущие главы по порядку." width={620} onClose={close}>
      <div className="content">
        <textarea
          className="textarea mono"
          style={{ minHeight: 180, fontSize: 12.5 }}
          placeholder={`${LIST_EXAMPLE}\n\nПодходит и формат OGM (CHAPTER01=…, CHAPTER01NAME=…)`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        {parsed.entries.length > 0 && (
          <>
            <div className="note">
              {parsed.timed
                ? `Будет ${parsed.entries.length} глав по таймкодам (сейчас ${count}).`
                : `Переименую ${Math.min(parsed.entries.length, count)} из ${count} глав по порядку.`}
            </div>
            <div className="preview-table">
              {parsed.entries.slice(0, 200).map((e, i) => (
                <div key={i}>
                  <span className="mono sub">{e.time !== undefined ? formatTime(e.time) : `#${i + 1}`}</span>
                  <span className="name">{e.title || <span className="sub">без названия</span>}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {[...parsed.errors, ...(result?.warnings ?? [])].slice(0, 6).map((e) => (
          <div key={e} className="note warn">{e}</div>
        ))}
      </div>
      <footer>
        <button className="btn" onClick={close}>Отмена</button>
        <button className="btn primary" disabled={!result || !result.chapters.length} onClick={apply}>Применить</button>
      </footer>
    </Modal>
  )
}

// ------------------------------------------------------------ build options

const PARTS: { v: PartsMode; label: string }[] = [
  { v: 'none', label: 'Одним файлом — без ограничений по длине' },
  { v: 'chapters', label: 'Части примерно по N часов, разрыв между главами' },
  { v: 'files', label: 'Части примерно по N часов, разрыв между файлами' },
  { v: 'exact', label: 'Части ровно по N часов' },
  { v: 'perChapter', label: 'Каждая глава — отдельный файл' },
]

const TAGS: { v: TagTarget; label: string }[] = [
  { v: 'artist', label: 'Artist' },
  { v: 'albumArtist', label: 'Album Artist' },
  { v: 'composer', label: 'Composer' },
]

function TagPicker(props: { value: TagTarget[]; onChange: (v: TagTarget[]) => void }) {
  return (
    <div className="inline" style={{ gap: 14 }}>
      {TAGS.map((t) => (
        <label key={t.v} className="check">
          <input
            type="checkbox"
            checked={props.value.includes(t.v)}
            onChange={(e) => props.onChange(e.target.checked ? [...props.value, t.v] : props.value.filter((x) => x !== t.v))}
          />
          {t.label}
        </label>
      ))}
    </div>
  )
}

export function BuildOptionsDialog() {
  const project = useStore((s) => s.project)
  const appleAac = useStore((s) => s.info?.appleAac ?? false)
  const commit = useStore((s) => s.commit)
  const set = useStore((s) => s.set)
  const close = () => set({ dialog: null })
  const [o, setO] = useState<BuildOptions>(project.build)
  const up = (patch: Partial<BuildOptions>) => setO((x) => ({ ...x, ...patch }))
  const pass = passthroughCheck(project, o)
  const setPreset = (preset: QualityPreset) => up(preset === 'custom' ? { preset } : { preset, ...QUALITY_PRESETS[preset] })
  const apply = () => {
    commit((p) => ({ ...p, build: o }))
    close()
  }
  const makeDefault = async () => {
    await window.api.setSettings({ defaults: o }).then((settings) => set({ settings }))
    useStore.getState().toast('success', 'Сохранено как параметры по умолчанию для новых книг')
  }
  const hours = o.partHours

  return (
    <Modal title="Параметры сборки" width={640} onClose={close}>
      <div className="content">
        <div className="form-row">
          <label>Формат</label>
          <div>
            <div className="segmented">
              <button className={o.format === 'm4b' ? 'on' : ''} onClick={() => up({ format: 'm4b' })}>M4B — аудиокнига</button>
              <button className={o.format === 'm4a' ? 'on' : ''} onClick={() => up({ format: 'm4a' })}>M4A — музыка</button>
            </div>
            <div className="help">M4B запоминает позицию и попадает в «Аудиокниги» на iPhone и в Apple Books.</div>
          </div>
        </div>

        <div className="form-row">
          <label>Без перекодирования</label>
          <div>
            <label className="check">
              <input type="checkbox" checked={o.passthrough} onChange={(e) => up({ passthrough: e.target.checked })} />
              Склеить как есть, если исходники совместимы
            </label>
            <div className="help">{pass.ok ? 'Сейчас возможно: качество сохранится, сборка займёт секунды.' : `Сейчас невозможно: ${pass.reason}.`}</div>
          </div>
        </div>

        <div className="form-row" style={{ opacity: o.passthrough && pass.ok ? 0.5 : 1 }}>
          <label>Качество</label>
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="segmented">
              {(['low', 'normal', 'high', 'custom'] as QualityPreset[]).map((q) => (
                <button key={q} className={o.preset === q ? 'on' : ''} onClick={() => setPreset(q)}>
                  {PRESET_LABEL[q]}
                </button>
              ))}
            </div>
            <div className="inline">
              <select className="select" style={{ width: 130 }} value={o.bitrate} disabled={o.preset !== 'custom'} onChange={(e) => up({ bitrate: Number(e.target.value) })}>
                {[24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 256, 320].map((b) => (
                  <option key={b} value={b}>{b} кбит/с</option>
                ))}
              </select>
              <select className="select" style={{ width: 110 }} value={o.channels} disabled={o.preset !== 'custom'} onChange={(e) => up({ channels: Number(e.target.value) as 1 | 2 })}>
                <option value={1}>моно</option>
                <option value={2}>стерео</option>
              </select>
              <select className="select" style={{ width: 120 }} value={o.sampleRate} disabled={o.preset !== 'custom'} onChange={(e) => up({ sampleRate: Number(e.target.value) })}>
                {[22050, 32000, 44100, 48000].map((r) => (
                  <option key={r} value={r}>{khz(r)}</option>
                ))}
              </select>
            </div>
            <div className="inline">
              <div className="segmented">
                <button className={o.encoder === 'aac' ? 'on' : ''} onClick={() => up({ encoder: 'aac' })}>AAC</button>
                <button className={o.encoder === 'he-aac' ? 'on' : ''} disabled={!appleAac} onClick={() => up({ encoder: 'he-aac' })}>HE-AAC</button>
              </div>
              <span className="muted">
                {appleAac ? 'Кодек Apple. HE-AAC лучше звучит на низких битрейтах (до ~40 кбит/с на канал).' : 'HE-AAC доступен в версии для macOS.'}
              </span>
            </div>
          </div>
        </div>

        <div className="form-row">
          <label>Файлы</label>
          <div style={{ display: 'grid', gap: 10 }}>
            <select className="select" value={o.partsMode} onChange={(e) => up({ partsMode: e.target.value as PartsMode })}>
              {PARTS.map((p) => (
                <option key={p.v} value={p.v}>{p.label}</option>
              ))}
            </select>
            {(o.partsMode === 'chapters' || o.partsMode === 'files' || o.partsMode === 'exact') && (
              <div className="inline" style={{ flexWrap: 'nowrap' }}>
                <input className="slider" type="range" min={1} max={50} step={0.5} value={hours} onChange={(e) => up({ partHours: Number(e.target.value) })} />
                <input className="input" style={{ width: 80 }} type="number" min={0.25} step={0.25} value={hours} onChange={(e) => up({ partHours: Math.max(0.25, Number(e.target.value) || 1) })} />
                <span>ч</span>
              </div>
            )}
          </div>
        </div>

        <div className="form-row">
          <label>Автор в тегах</label>
          <TagPicker value={o.authorTags} onChange={(authorTags) => up({ authorTags })} />
        </div>
        <div className="form-row">
          <label>Чтец в тегах</label>
          <div>
            <TagPicker value={o.narratorTags} onChange={(narratorTags) => up({ narratorTags })} />
            <div className="help">Чтец также всегда пишется в отдельный тег Narrator, его читает Apple Books.</div>
          </div>
        </div>

        <div className="form-row">
          <label>Картинки глав</label>
          <div className="inline">
            <select className="select" style={{ width: 130 }} value={o.chapterImageSize} onChange={(e) => up({ chapterImageSize: Number(e.target.value) })}>
              {[400, 600, 800, 1000].map((s) => (
                <option key={s} value={s}>{s}×{s}</option>
              ))}
            </select>
            <label className="inline">
              фон
              <input type="color" value={o.chapterImageBackground} onChange={(e) => up({ chapterImageBackground: e.target.value })} style={{ width: 40, height: 28, border: 'none', background: 'none' }} />
            </label>
            <span className="muted">Главы без картинки показывают обложку.</span>
          </div>
        </div>
      </div>
      <footer>
        <button className="btn left ghost" onClick={makeDefault}>Сделать по умолчанию</button>
        <button className="btn" onClick={close}>Отмена</button>
        <button className="btn primary" onClick={apply}>Готово</button>
      </footer>
    </Modal>
  )
}

// ------------------------------------------------------------ settings

export function SettingsDialog() {
  const settings = useStore((s) => s.settings)
  const info = useStore((s) => s.info)
  const set = useStore((s) => s.set)
  const close = () => set({ dialog: null })
  if (!settings) return null
  const save = (patch: Partial<typeof settings>) => window.api.setSettings(patch).then((s) => set({ settings: s }))
  const pickDir = async () => {
    const d = await window.api.pickOutputDir()
    if (d) save({ outputDir: d, outputMode: 'fixed' })
  }
  return (
    <Modal title="Настройки" width={600} onClose={close}>
      <div className="content">
        <div className="form-row">
          <label>Названия файлов</label>
          <div>
            <div className="segmented">
              <button className={settings.titleSource === 'tag' ? 'on' : ''} onClick={() => save({ titleSource: 'tag' })}>Из тегов</button>
              <button className={settings.titleSource === 'filename' ? 'on' : ''} onClick={() => save({ titleSource: 'filename' })}>Из имени файла</button>
            </div>
            <div className="help">Откуда брать название добавляемого файла (и его главы).</div>
          </div>
        </div>
        <div className="form-row">
          <label>Новые файлы</label>
          <label className="check">
            <input type="checkbox" checked={settings.chapterPerFile} onChange={(e) => save({ chapterPerFile: e.target.checked })} />
            Каждый добавленный файл начинает новую главу
          </label>
        </div>
        <div className="form-row">
          <label>Куда сохранять</label>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="segmented">
              <button className={settings.outputMode === 'ask' ? 'on' : ''} onClick={() => save({ outputMode: 'ask' })}>Спрашивать</button>
              <button className={settings.outputMode === 'fixed' ? 'on' : ''} onClick={() => save({ outputMode: 'fixed' })}>В папку</button>
            </div>
            <div className="inline" style={{ flexWrap: 'nowrap' }}>
              <input className="input" readOnly value={settings.outputDir} />
              <button className="btn" onClick={pickDir}>
                <FolderOpen size={15} /> Выбрать
              </button>
            </div>
          </div>
        </div>
        <div className="form-row">
          <label>ffmpeg</label>
          <div className="muted" style={{ paddingTop: 6 }}>
            {info?.ffmpeg ? `версия ${info.ffmpeg}${info.appleAac ? ' · кодек Apple AAC доступен' : ''}` : `не найден: ${info?.ffmpegError ?? ''}`}
          </div>
        </div>
      </div>
      <footer>
        <span className="left sub">Audiobinder {info?.version}</span>
        <button className="btn primary" onClick={close}>Готово</button>
      </footer>
    </Modal>
  )
}
