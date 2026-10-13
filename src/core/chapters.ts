// Chapter timeline: pure functions over the project model.

import type { Chapter, Project, SourceFile } from './types.ts'

export interface TimedChapter extends Chapter {
  index: number
  start: number // seconds on the book timeline
  end: number
  duration: number
}

const EPS = 0.001

export function fileStarts(files: SourceFile[]): Map<string, number> {
  const m = new Map<string, number>()
  let t = 0
  for (const f of files) {
    m.set(f.id, t)
    t += f.duration
  }
  return m
}

export function totalDuration(files: SourceFile[]): number {
  return files.reduce((a, f) => a + f.duration, 0)
}

/** Chapters placed on the timeline, sorted, de-duplicated, with ends filled in. */
export function timeline(p: Pick<Project, 'files' | 'chapters'>): TimedChapter[] {
  const starts = fileStarts(p.files)
  const durations = new Map(p.files.map((f) => [f.id, f.duration]))
  const placed = p.chapters
    .filter((c) => starts.has(c.fileId))
    .map((c, order) => ({
      c,
      order,
      start: starts.get(c.fileId)! + Math.min(Math.max(c.offset, 0), durations.get(c.fileId)!),
    }))
    .sort((a, b) => a.start - b.start || a.order - b.order)
  const out: TimedChapter[] = []
  for (const x of placed) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(prev.start - x.start) < EPS) continue
    out.push({ ...x.c, index: out.length, start: x.start, end: 0, duration: 0 })
  }
  const total = totalDuration(p.files)
  for (let i = 0; i < out.length; i++) {
    out[i].end = i + 1 < out.length ? out[i + 1].start : total
    out[i].duration = out[i].end - out[i].start
  }
  return out
}

/** Maps a book time to the file containing it. Times at a boundary belong to the next file. */
export function locate(files: SourceFile[], t: number): { fileId: string; offset: number } | undefined {
  let start = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const last = i === files.length - 1
    if (t < start + f.duration - EPS || (last && t <= start + f.duration + EPS)) {
      return { fileId: f.id, offset: Math.max(0, t - start) }
    }
    start += f.duration
  }
  return undefined
}

export function newChapter(fileId: string, offset: number, title: string, image?: string): Chapter {
  return { id: crypto.randomUUID(), fileId, offset, title, ...(image ? { image } : {}) }
}

export function chaptersPerFile(files: SourceFile[]): Chapter[] {
  return files.map((f) => newChapter(f.id, 0, f.name))
}

/** Merges each run of consecutive selected chapters into the first chapter of the run. */
export function joinChapters(p: Project, ids: string[]): Chapter[] {
  const sel = new Set(ids)
  const tl = timeline(p)
  const drop = new Set<string>()
  for (let i = 1; i < tl.length; i++) {
    if (sel.has(tl[i].id) && sel.has(tl[i - 1].id)) drop.add(tl[i].id)
  }
  return p.chapters.filter((c) => !drop.has(c.id))
}

/** Adds a chapter at every file boundary inside the selected chapters. */
export function splitByFiles(p: Project, ids: string[]): Chapter[] {
  const sel = new Set(ids)
  const tl = timeline(p)
  const starts = fileStarts(p.files)
  const added: Chapter[] = []
  for (const ch of tl) {
    if (!sel.has(ch.id)) continue
    for (const f of p.files) {
      const s = starts.get(f.id)!
      if (s > ch.start + EPS && s < ch.end - EPS) added.push(newChapter(f.id, 0, f.name))
    }
  }
  return [...p.chapters, ...added]
}

export function addChapterAt(p: Project, t: number, title?: string): { chapters: Chapter[]; id?: string } {
  const loc = locate(p.files, t)
  if (!loc) return { chapters: p.chapters }
  const tl = timeline(p)
  if (tl.some((c) => Math.abs(c.start - t) < 0.05)) return { chapters: p.chapters }
  const ch = newChapter(loc.fileId, loc.offset, title ?? `Глава ${tl.filter((c) => c.start < t).length + 1}`)
  return { chapters: [...p.chapters, ch], id: ch.id }
}

/** Moves a chapter to a new book time (re-anchoring it to the file at that time). */
export function setChapterStart(p: Project, id: string, t: number): Chapter[] {
  const loc = locate(p.files, t)
  if (!loc) return p.chapters
  return p.chapters.map((c) => (c.id === id ? { ...c, fileId: loc.fileId, offset: loc.offset } : c))
}

/**
 * Removes files. Chapters anchored in removed files move to the first surviving
 * file they used to cover, so later files don't silently fall into the previous chapter.
 */
export function removeFiles(p: Project, fileIds: string[]): Pick<Project, 'files' | 'chapters'> {
  const gone = new Set(fileIds)
  const files = p.files.filter((f) => !gone.has(f.id))
  const oldStarts = fileStarts(p.files)
  const tl = timeline(p)
  const anchoredAtZero = new Set(p.chapters.filter((c) => !gone.has(c.fileId) && c.offset < EPS).map((c) => c.fileId))
  const chapters: Chapter[] = []
  for (const c of p.chapters) {
    if (!gone.has(c.fileId)) {
      chapters.push(c)
      continue
    }
    const t = tl.find((x) => x.id === c.id)
    if (!t) continue
    const heir = files.find((f) => {
      const s = oldStarts.get(f.id)!
      return s >= t.start - EPS && s < t.end - EPS
    })
    if (heir && !anchoredAtZero.has(heir.id)) {
      anchoredAtZero.add(heir.id)
      chapters.push({ ...c, fileId: heir.id, offset: 0 })
    }
  }
  return { files, chapters }
}

// ------------------------------------------------------------ time format

export function formatTime(sec: number, ms = false): string {
  const neg = sec < 0
  let s = Math.abs(sec)
  if (!ms) s = Math.round(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s - h * 3600 - m * 60
  const ss = ms ? r.toFixed(3).padStart(6, '0') : String(Math.floor(r)).padStart(2, '0')
  return `${neg ? '-' : ''}${h}:${String(m).padStart(2, '0')}:${ss}`
}

/** Accepts H:MM:SS(.mmm), MM:SS, or plain seconds; comma works as decimal separator. */
export function parseTime(s: string): number | undefined {
  const t = s.trim().replace(',', '.')
  if (!t) return undefined
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t)
  if (!m) return undefined
  const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])]
  if (mm >= 60 || ss >= 60) return undefined
  return h * 3600 + mm * 60 + ss
}

// ------------------------------------------------------------ chapter lists

export interface ListEntry {
  time?: number
  title: string
}

export interface ParsedList {
  entries: ListEntry[]
  timed: boolean
  errors: string[]
}

const TIME_PREFIX = /^\s*[[(]?((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*(?:[-–—|:]\s*)?(.*)$/
const OGM_TIME = /^\s*CHAPTER(\d+)\s*=\s*(\S+)\s*$/i
const OGM_NAME = /^\s*CHAPTER(\d+)NAME\s*=\s*(.*)$/i

/**
 * Parses pasted chapter lists: "0:00 Title" lines (YouTube/Audible style), OGM
 * (CHAPTER01=…, CHAPTER01NAME=…), or plain titles, one per line.
 */
export function parseChapterList(text: string): ParsedList {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter((l) => l.trim())
  const errors: string[] = []

  if (lines.some((l) => OGM_TIME.test(l))) {
    const times = new Map<string, number>()
    const names = new Map<string, string>()
    for (const l of lines) {
      const n = OGM_NAME.exec(l)
      if (n) {
        names.set(n[1], n[2].trim())
        continue
      }
      const t = OGM_TIME.exec(l)
      if (t) {
        const v = parseTime(t[2])
        if (v === undefined) errors.push(`Не понял время: ${l.trim()}`)
        else times.set(t[1], v)
      }
    }
    const entries = [...times.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, time]) => ({ time, title: names.get(k) ?? '' }))
    return { entries, timed: true, errors }
  }

  const parsed = lines.map((l) => {
    const m = TIME_PREFIX.exec(l)
    const time = m ? parseTime(m[1]) : undefined
    return time === undefined ? { title: l.trim() } : { time, title: m![2].trim() }
  })
  const withTime = parsed.filter((e) => e.time !== undefined).length
  if (withTime === 0) return { entries: parsed, timed: false, errors }
  if (withTime < parsed.length) {
    for (const e of parsed) if (e.time === undefined) errors.push(`Нет таймкода: ${e.title}`)
  }
  return { entries: parsed.filter((e) => e.time !== undefined), timed: true, errors }
}

/**
 * Applies a parsed list: timed lists replace the chapters (images kept where a
 * chapter starts within a second of an old one), untimed lists rename in order.
 */
export function applyChapterList(p: Project, list: ParsedList): { chapters: Chapter[]; warnings: string[] } {
  const warnings: string[] = []
  const tl = timeline(p)
  if (!list.timed) {
    const titles = list.entries.map((e) => e.title)
    if (titles.length !== tl.length) warnings.push(`Названий ${titles.length}, а глав ${tl.length}: лишние пропущены`)
    const byId = new Map(tl.map((c, i) => [c.id, titles[i]]))
    return { chapters: p.chapters.map((c) => (byId.get(c.id) ? { ...c, title: byId.get(c.id)! } : c)), warnings }
  }
  const total = totalDuration(p.files)
  const chapters: Chapter[] = []
  const entries = [...list.entries].sort((a, b) => a.time! - b.time!)
  entries.forEach((e, i) => {
    if (e.time! > total + EPS) {
      warnings.push(`${formatTime(e.time!)} позже конца книги (${formatTime(total)}) — пропущено`)
      return
    }
    const loc = locate(p.files, e.time!)!
    const old = tl.find((c) => Math.abs(c.start - e.time!) < 1)
    chapters.push(newChapter(loc.fileId, loc.offset, e.title || `Глава ${i + 1}`, old?.image))
  })
  return { chapters, warnings }
}

export function chaptersToText(p: Project): string {
  return timeline(p)
    .map((c) => `${formatTime(c.start, true)} ${c.title}`)
    .join('\n')
}

// ------------------------------------------------------------ renaming

export interface RenameOptions {
  template: string // tokens: {n} number, {N} count, {name} current title, {title} book title
  start: number
  pad: number // 0 = no padding
  bookTitle: string
}

export const RENAME_PRESETS = ['Глава {n}', 'Глава {n}: {name}', '{n}. {name}', '{title} — глава {n}', 'Часть {n} из {N}']

export function renderName(o: RenameOptions, i: number, count: number, name: string): string {
  const num = (v: number) => (o.pad > 0 ? String(v).padStart(o.pad, '0') : String(v))
  return o.template
    .replaceAll('{n}', num(o.start + i))
    .replaceAll('{N}', num(count))
    .replaceAll('{name}', name)
    .replaceAll('{title}', o.bookTitle)
    .trim()
}

/** Renames the selected chapters (in timeline order) by template. */
export function renameChapters(p: Project, ids: string[], o: RenameOptions): Chapter[] {
  const sel = new Set(ids)
  const ordered = timeline(p).filter((c) => sel.has(c.id))
  const names = new Map(ordered.map((c, i) => [c.id, renderName(o, i, ordered.length, c.title)]))
  return p.chapters.map((c) => (names.has(c.id) ? { ...c, title: names.get(c.id)! } : c))
}
