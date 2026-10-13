import { useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardPaste, ImagePlus, Trash2 } from 'lucide-react'
import type { BookMeta } from '../../../core/types.ts'
import { useImageDrop } from '../hooks.ts'
import { useStore } from '../store.ts'

function Field(props: {
  label: string
  k: keyof BookMeta
  placeholder?: string
  list?: string
  className?: string
  multiline?: boolean
}) {
  const value = useStore((s) => (s.project.meta[props.k] as string) ?? '')
  const setMeta = useStore((s) => s.setMeta)
  const onChange = (v: string) => setMeta({ [props.k]: v } as Partial<BookMeta>, `meta.${props.k}`)
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.multiline ? (
        <textarea className="textarea" value={value} placeholder={props.placeholder} onChange={(e) => onChange(e.target.value)} spellCheck />
      ) : (
        <input
          className={`input ${props.className ?? ''}`}
          value={value}
          placeholder={props.placeholder}
          list={props.list}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      )}
    </label>
  )
}

function Cover() {
  const cover = useStore((s) => s.project.meta.cover)
  const setMeta = useStore((s) => s.setMeta)
  const setCover = (p: string | undefined) => setMeta({ cover: p })
  const { over, handlers } = useImageDrop((p) => setCover(p))
  const pick = async () => {
    const p = await window.api.pickImage()
    if (p) setCover(p)
  }
  const paste = async () => {
    const p = await window.api.pasteImage()
    if (p) setCover(p)
    else useStore.getState().toast('info', 'В буфере обмена нет картинки')
  }
  return (
    <div className={`cover ${cover ? 'has' : ''} ${over ? 'over' : ''}`} {...handlers} onDoubleClick={pick}>
      {cover ? (
        <img src={window.api.mediaUrl(cover)} alt="" draggable={false} />
      ) : (
        <div className="hint">
          <ImagePlus size={30} strokeWidth={1.5} />
          <div>
            Перетащите обложку
            <br />
            или <a onClick={pick} style={{ color: 'var(--accent)', cursor: 'pointer' }}>выберите файл</a>
          </div>
        </div>
      )}
      <div className="tools" style={cover ? undefined : { opacity: 1 }}>
        <button title="Вставить из буфера" onClick={paste}>
          <ClipboardPaste size={15} />
        </button>
        {cover && (
          <>
            <button title="Заменить" onClick={pick}>
              <ImagePlus size={15} />
            </button>
            <button title="Убрать обложку" onClick={() => setCover(undefined)}>
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function BookPanel() {
  const [more, setMore] = useState(false)
  const recent = useStore((s) => s.settings?.recent)
  return (
    <aside className="sidebar">
      <Cover />
      <div className="fields">
        <Field label="Название" k="title" className="title" placeholder="Название книги" />
        <Field label="Автор" k="author" placeholder="Имя автора" list="dl-authors" />
        <Field label="Читает" k="narrator" placeholder="Чтец" list="dl-narrators" />
        <div className="row2">
          <Field label="Жанр" k="genre" placeholder="Жанр" list="dl-genres" />
          <Field label="Год" k="year" placeholder="—" />
        </div>
        <Field label="Описание" k="description" placeholder="Аннотация книги" multiline />
        <button className="more-toggle" onClick={() => setMore(!more)}>
          {more ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          Ещё поля
        </button>
        {more && (
          <>
            <Field label="Издатель" k="publisher" />
            <Field label="Авторские права" k="copyright" placeholder="© 2026 …" />
            <Field label="Комментарий" k="comment" />
            <Field label="Текст (Lyrics)" k="lyrics" multiline placeholder="Показывается на экране «Исполняется» на iPhone" />
            <Field label="Кодировщик" k="encodedBy" placeholder="Кто собрал книгу" />
          </>
        )}
      </div>
      <datalist id="dl-authors">{recent?.authors.map((a) => <option key={a} value={a} />)}</datalist>
      <datalist id="dl-narrators">{recent?.narrators.map((a) => <option key={a} value={a} />)}</datalist>
      <datalist id="dl-genres">
        {[...new Set([...(recent?.genres ?? []), 'Аудиокниги', 'Фэнтези', 'Фантастика', 'Детектив', 'Классика', 'Нон-фикшн', 'Детская литература'])].map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </aside>
  )
}
