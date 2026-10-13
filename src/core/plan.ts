// Build planning: parts, pass-through eligibility, tag mapping, output names.

import { fileStarts, locate, timeline, totalDuration, type TimedChapter } from './chapters.ts'
import type { BookMeta, BuildOptions, Project, TagTarget } from './types.ts'
import type { Tag } from './mp4.ts'

export interface Cut {
  fileIndex: number
  offset: number // seconds into that file
}

export interface PartPlan {
  index: number // 0-based
  from: Cut
  to?: Cut // exclusive; undefined = end of book
  start: number // approximate book time (seconds) — exact positions come from decoding
  end: number
  chapters: TimedChapter[] // chapters whose start falls into this part
}

const EPS = 0.001

/** Groups consecutive units so that each part lands as close to the target as possible. */
function groupUnits(durations: number[], target: number): number[] {
  const breaks = [0]
  let acc = 0
  durations.forEach((d, i) => {
    if (acc > 0 && Math.abs(acc + d - target) > Math.abs(acc - target)) {
      breaks.push(i)
      acc = 0
    }
    acc += d
  })
  return breaks
}

export function planParts(p: Project, o: BuildOptions): PartPlan[] {
  const files = p.files
  if (!files.length) return []
  const total = totalDuration(files)
  const tl = timeline(p)
  const target = Math.max(1, o.partHours * 3600)
  const starts = fileStarts(files)
  let cuts: Cut[] = [{ fileIndex: 0, offset: 0 }]

  const cutAtChapter = (c: TimedChapter): Cut => ({ fileIndex: files.findIndex((f) => f.id === c.fileId), offset: c.offset })

  if (o.partsMode === 'perChapter' && tl.length > 1) {
    cuts = [cuts[0], ...tl.slice(1).map(cutAtChapter)]
  } else if (o.partsMode === 'chapters' && tl.length > 1) {
    const units = tl.map((c, i) => (i === 0 ? c.end : c.duration))
    cuts = groupUnits(units, target).map((i) => (i === 0 ? cuts[0] : cutAtChapter(tl[i])))
  } else if (o.partsMode === 'files' && files.length > 1) {
    cuts = groupUnits(files.map((f) => f.duration), target).map((i) => ({ fileIndex: i, offset: 0 }))
  } else if (o.partsMode === 'exact' && total > target + 1) {
    for (let t = target; t < total - 1; t += target) {
      const loc = locate(files, t)!
      cuts.push({ fileIndex: files.findIndex((f) => f.id === loc.fileId), offset: loc.offset })
    }
  }

  const timeOf = (c: Cut) => starts.get(files[c.fileIndex].id)! + c.offset
  return cuts.map((from, i) => {
    const to = cuts[i + 1]
    const start = timeOf(from)
    const end = to ? timeOf(to) : total
    return {
      index: i,
      from,
      to,
      start,
      end,
      chapters: tl.filter((c) => (i === 0 || c.start >= start - EPS) && (!to || c.start < end - EPS)),
    }
  })
}

// ------------------------------------------------------------ pass-through

export function passthroughCheck(p: Project, o: BuildOptions): { ok: boolean; reason?: string } {
  const f = p.files
  if (!f.length) return { ok: false, reason: 'нет файлов' }
  if (!f.every((x) => x.codec === 'aac')) return { ok: false, reason: 'не все файлы в AAC' }
  if (!f.every((x) => /mp4|mov|m4a/.test(x.container))) return { ok: false, reason: 'не все файлы в контейнере MP4/M4A' }
  const a = f[0]
  if (!f.every((x) => x.sampleRate === a.sampleRate && x.channels === a.channels && x.profile === a.profile)) {
    return { ok: false, reason: 'файлы различаются частотой, каналами или профилем AAC' }
  }
  if (o.partsMode === 'exact') return { ok: false, reason: 'точное деление на части режет файлы посередине' }
  if (o.partsMode === 'chapters' || o.partsMode === 'perChapter') {
    if (timeline(p).some((c) => c.offset > EPS)) return { ok: false, reason: 'есть главы внутри файлов — части пришлось бы резать' }
  }
  return { ok: true }
}

// ------------------------------------------------------------ tags

const TARGET_ATOM: Record<TagTarget, string> = { artist: '©ART', albumArtist: 'aART', composer: '©wrt' }

export function buildTags(
  meta: BookMeta,
  o: BuildOptions,
  extra: { part?: { n: number; of: number }; title?: string; tool: string },
): Tag[] {
  const text = (atom: string, value: string): Tag => ({ atom, value: { kind: 'text', value: value.trim() } })
  const people = new Map<string, string[]>()
  const put = (targets: TagTarget[], who: string) => {
    if (!who.trim()) return
    for (const t of targets) people.set(TARGET_ATOM[t], [...(people.get(TARGET_ATOM[t]) ?? []), who.trim()])
  }
  put(o.authorTags, meta.author)
  put(o.narratorTags, meta.narrator)

  const tags: Tag[] = [
    text('©nam', extra.title ?? meta.title),
    text('©alb', meta.title),
    ...[...people.entries()].map(([atom, names]) => text(atom, [...new Set(names)].join(', '))),
    text('©nrt', meta.narrator),
    text('©gen', meta.genre),
    text('©day', meta.year),
    text('desc', meta.description.slice(0, 255)),
    text('ldes', meta.description),
    text('cprt', meta.copyright),
    text('©pub', meta.publisher),
    text('©cmt', meta.comment),
    text('©lyr', meta.lyrics),
    text('©enc', meta.encodedBy),
    text('©too', extra.tool),
  ]
  if (o.format === 'm4b') tags.push({ atom: 'stik', value: { kind: 'int8', value: 2 } })
  if (extra.part) tags.push({ atom: 'trkn', value: { kind: 'pair', n: extra.part.n, of: extra.part.of } })
  return tags
}

// ------------------------------------------------------------ names

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** Makes a string safe as a file name on macOS and Windows. */
export function safeFileName(s: string, fallback = 'Аудиокнига'): string {
  let r = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (!r || RESERVED.test(r)) r = fallback
  return r.length > 180 ? r.slice(0, 180).trim() : r
}

export function outputBaseName(meta: BookMeta): string {
  const title = meta.title.trim() || 'Аудиокнига'
  return safeFileName(meta.author.trim() ? `${meta.author.trim()} - ${title}` : title)
}

export function partFileName(meta: BookMeta, o: BuildOptions, part: PartPlan, count: number): string {
  const base = outputBaseName(meta)
  const ext = `.${o.format}`
  if (count <= 1) return base + ext
  const num = String(part.index + 1).padStart(String(count).length, '0')
  if (o.partsMode === 'perChapter' && part.chapters[0]) {
    return safeFileName(`${base} - ${num} ${part.chapters[0].title}`) + ext
  }
  return safeFileName(`${base} (часть ${num})`) + ext
}

export function estimateBytes(p: Project, o: BuildOptions): number {
  const total = totalDuration(p.files)
  if (o.passthrough && passthroughCheck(p, o).ok) {
    return p.files.reduce((a, f) => a + (f.bitRate / 8) * f.duration, 0) * 1.01
  }
  return ((o.bitrate * 1000) / 8) * total * 1.02
}
