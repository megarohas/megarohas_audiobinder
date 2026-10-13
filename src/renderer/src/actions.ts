// User-level flows that talk to the main process.

import { addChapterAt, chaptersPerFile, newChapter, removeFiles, timeline } from '../../core/chapters.ts'
import type { Chapter, Project } from '../../core/types.ts'
import { pause, usePlayer } from './player.ts'
import { newProjectFromSettings, useStore } from './store.ts'

const api = () => window.api
const st = () => useStore.getState()

function errorText(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    st().toast('error', 'Что-то пошло не так', errorText(e))
    return undefined
  }
}

async function confirmDiscard(): Promise<boolean> {
  const s = st()
  if (!s.dirty || !s.project.files.length) return true
  const r = await api().confirm('Есть несохранённые изменения', 'Текущий проект не сохранён. Продолжить без сохранения?', ['Продолжить', 'Отмена'])
  return r === 0
}

// ------------------------------------------------------------ adding audio

export async function addPaths(paths: string[]): Promise<void> {
  const projects = paths.filter((p) => p.toLowerCase().endsWith('.abproj'))
  if (projects.length) return openProject(projects[0])
  await guard(async () => {
    const expanded = await api().expand(paths)
    if (!expanded.length) {
      st().toast('info', 'Аудиофайлов не нашлось', 'Поддерживаются MP3, M4A/M4B, FLAC, WAV, OGG/Opus, AAC, AIFF, WMA и другие')
      return
    }
    const s = st()
    s.set({ busy: { label: 'Читаю файлы', done: 0, total: expanded.length } })
    const off = api().onProbeProgress((done, total) => st().set({ busy: { label: 'Читаю файлы', done, total } }))
    try {
      const { results, errors } = await api().probe(expanded, s.settings?.titleSource ?? 'tag')
      if (errors.length) st().toast('error', `Не удалось добавить: ${errors.length}`, errors.slice(0, 5).join('\n'))
      if (!results.length) return
      const wasEmpty = !st().project.files.length
      const perFile = st().settings?.chapterPerFile ?? true

      st().commit((p) => {
        const files = [...p.files, ...results.map((r) => r.file)]
        const chapters: Chapter[] = [...p.chapters]
        for (const r of results) {
          if (r.chapters.length > 1) {
            for (const c of r.chapters) chapters.push(newChapter(r.file.id, c.start, c.title))
          } else if (perFile || chapters.length === 0) {
            chapters.push(...chaptersPerFile([r.file]))
          }
        }
        return { ...p, files, chapters }
      })

      if (wasEmpty) await fillMetaFromTags(results[0].file.tags, results[0].file.path)
      st().set({ tab: st().tab })
      st().toast('success', `Добавлено файлов: ${results.length}`)
    } finally {
      off()
      st().set({ busy: null })
    }
  })
}

async function fillMetaFromTags(t: Record<string, string>, path: string): Promise<void> {
  const m = st().project.meta
  const patch = {
    title: m.title || t.album || '',
    author: m.author || t.album_artist || t.artist || '',
    narrator: m.narrator || t.composer || '',
    genre: m.genre || t.genre || '',
    year: m.year || (t.date || t.year || '').slice(0, 4),
    description: m.description || t.description || t.comment || '',
  }
  const cover = m.cover ? undefined : await api().extractCover(path)
  st().commit((p) => ({ ...p, meta: { ...p.meta, ...patch, ...(cover ? { cover } : {}) } }), 'autofill')
}

export async function pickAndAdd(kind: 'files' | 'folder'): Promise<void> {
  const paths = await guard(() => (kind === 'files' ? api().pickAudio() : api().pickFolder()))
  if (paths?.length) await addPaths(paths)
}

// ------------------------------------------------------------ documents

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return
  pause()
  st().load(newProjectFromSettings(st().settings))
}

export async function openProject(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return
  const r = await guard(() => api().openProject(path))
  if (!r) return
  pause()
  st().load(r.project, r.path, r.missing)
  if (r.missing.length) st().toast('error', `Не найдено файлов: ${r.missing.length}`, r.missing.slice(0, 5).join('\n'))
}

export async function importBook(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return
  st().set({ busy: { label: 'Открываю книгу', done: 0, total: 0 } })
  try {
    const r = await guard(() => api().importBook(path))
    if (!r) return
    pause()
    const p: Project = { ...newProjectFromSettings(st().settings), meta: r.meta, files: [r.file], chapters: r.chapters }
    st().load(p)
    st().set({ dirty: true })
    for (const w of r.warnings) st().toast('info', w)
    st().toast('success', `Открыта книга: ${timeline(p).length} глав`)
  } finally {
    st().set({ busy: null })
  }
}

export async function saveProject(saveAs = false): Promise<void> {
  const s = st()
  const path = await guard(() => api().saveProject(s.project, s.path, saveAs))
  if (path) {
    st().markSaved(path)
    st().toast('success', 'Проект сохранён')
  }
}

// ------------------------------------------------------------ editing

export function removeSelection(): void {
  const s = st()
  if (s.tab === 'chapters' && s.selChapters.length) {
    const sel = new Set(s.selChapters)
    s.commit((p) => ({ ...p, chapters: p.chapters.filter((c) => !sel.has(c.id)) }))
    s.set({ selChapters: [] })
  } else if (s.tab === 'files' && s.selFiles.length) {
    s.commit((p) => ({ ...p, ...removeFiles(p, s.selFiles) }))
    s.set({ selFiles: [] })
  }
}

export function selectAll(): void {
  const s = st()
  if (s.tab === 'chapters') s.set({ selChapters: timeline(s.project).map((c) => c.id) })
  else s.set({ selFiles: s.project.files.map((f) => f.id) })
}

export function markChapterAtPlayer(): void {
  const s = st()
  const t = usePlayer.getState().time
  const r = addChapterAt(s.project, t)
  if (!r.id) {
    s.toast('info', 'Здесь уже есть глава')
    return
  }
  s.commit((p) => ({ ...p, chapters: r.chapters }))
  s.set({ tab: 'chapters', selChapters: [r.id], editChapter: r.id })
}

// ------------------------------------------------------------ build

export async function startBuild(): Promise<void> {
  const s = st()
  if (s.build.running) return
  if (!s.project.files.length) {
    s.toast('info', 'Сначала добавьте аудиофайлы')
    return
  }
  if (s.info && !s.info.ffmpeg) {
    s.toast('error', 'Не найден ffmpeg', s.info.ffmpegError)
    return
  }
  if (s.missing.length) {
    s.toast('error', 'Часть файлов не найдена', 'Удалите отсутствующие файлы из списка или верните их на место')
    return
  }
  pause()
  s.set({ build: { running: true } })
  const off = api().onBuildProgress((progress) => st().set({ build: { ...st().build, progress } }))
  try {
    const result = await api().build(s.project)
    if (!result) st().set({ build: { running: false } })
    else st().set({ build: { running: false, result } })
  } catch (e) {
    const msg = errorText(e)
    if (/Отменено/.test(msg)) {
      st().set({ build: { running: false } })
      st().toast('info', 'Сборка отменена')
    } else st().set({ build: { running: false, error: msg } })
  } finally {
    off()
  }
}
