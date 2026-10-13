// The build pipeline: sources → (decode → PCM → AAC | stream copy) → chapters → tags/art.

import { once } from 'node:events'
import { mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { timeline } from './chapters.ts'
import { AbortError, capabilities, lastLines, runTool, spawnTool } from './ffmpeg.ts'
import { finalizeMp4, type ChapterImages } from './mp4.ts'
import { buildTags, estimateBytes, partFileName, passthroughCheck, planParts, type PartPlan } from './plan.ts'
import type { BuildOptions, BuildProgress, BuildResult, Project, SourceFile } from './types.ts'

export interface BuildRequest {
  project: Project
  outputDir: string
  tool: string // written to ©too, e.g. "Audiobinder 0.1.0"
  signal?: AbortSignal
  onProgress?: (p: BuildProgress) => void
}

interface PartChapter {
  start: number // seconds from part start
  title: string
  image?: string
}

interface Segment {
  file: SourceFile
  fileIndex: number
  from: number // seconds into the file
  to?: number // exclusive; undefined = to the end of the file
}

const TEMP_PREFIX = '.audiobinder-'

export function plannedOutputs(project: Project, outputDir: string): string[] {
  const parts = planParts(project, project.build)
  return parts.map((p) => join(outputDir, partFileName(project.meta, project.build, p, parts.length)))
}

export async function buildBook(req: BuildRequest): Promise<BuildResult> {
  const { project, outputDir, signal } = req
  const o = project.build
  const t0 = Date.now()
  if (!project.files.length) throw new Error('Добавьте аудиофайлы')

  for (const f of project.files) {
    const st = await stat(f.path).catch(() => undefined)
    if (!st) throw new Error(`Файл не найден: ${f.path}`)
  }

  const caps = await capabilities()
  const parts = planParts(project, o)
  const passthrough = o.passthrough && passthroughCheck(project, o).ok
  const outputs = parts.map((p) => join(outputDir, partFileName(project.meta, o, p, parts.length)))

  // Space: every final file plus the largest part twice (temp audio + muxed copy).
  const need = estimateBytes(project, o)
  const fs = await statfs(outputDir)
  const free = Number(fs.bavail) * Number(fs.bsize)
  const largest = need * Math.max(...parts.map((p) => (p.end - p.start) / Math.max(1, parts[parts.length - 1].end)))
  if (free < need + largest + 50e6) {
    throw new Error(`Мало места: нужно около ${gb(need + largest)}, свободно ${gb(free)}`)
  }

  const tmp = await mkdtemp(join(tmpdir(), 'audiobinder-'))
  const tempFiles = new Set<string>()
  const progress = new Progress(parts, passthrough, req.onProgress)

  try {
    progress.emit('prepare', 0, 'Подготовка обложки и картинок глав')
    const art = await prepareArt(project, o, tmp, signal)

    for (const part of parts) {
      const n = part.index + 1
      const stem = join(outputDir, `${TEMP_PREFIX}${process.pid}-${Date.now()}-${n}`)
      const audioTmp = `${stem}.audio.m4a`
      const muxTmp = `${stem}.${o.format}`
      tempFiles.add(audioTmp).add(muxTmp)

      const segments = segmentsOf(project, part)
      const actual = passthrough
        ? await copyAudio(segments, audioTmp, progress, part, signal)
        : await encodeAudio(segments, audioTmp, o, caps.appleAac, progress, part, signal)

      const chapters = partChapters(project, part, segments, actual.durations)
      await mux(audioTmp, muxTmp, chapters, tmp, actual.total, progress, part, signal)
      await rm(audioTmp, { force: true })

      progress.emit('finalize', n, 'Запись тегов и обложки')
      const images = art.chapterImages ? chapterImagesFor(chapters, art, o) : undefined
      await finalizeMp4(muxTmp, {
        majorBrand: o.format === 'm4b' ? 'M4B ' : 'M4A ',
        tags: [
          ...buildTags(project.meta, o, {
            tool: req.tool,
            part: parts.length > 1 ? { n, of: parts.length } : undefined,
            title: parts.length > 1 ? partTitle(project, o, part, parts.length) : undefined,
          }),
          ...(art.cover ? [{ atom: 'covr', value: { kind: 'image' as const, value: art.cover.data, format: art.cover.format } }] : []),
        ],
        chapterImages: images,
      })
      await rename(muxTmp, outputs[part.index])
      tempFiles.delete(muxTmp)
      progress.partDone(part)
    }
    progress.emit('done', parts.length, 'Готово', 1)
    return { outputs, seconds: (Date.now() - t0) / 1000, passthrough }
  } finally {
    await Promise.all([...tempFiles].map((f) => rm(f, { force: true })))
    await rm(tmp, { recursive: true, force: true })
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} ГБ`
}

function partTitle(p: Project, o: BuildOptions, part: PartPlan, count: number): string {
  const title = p.meta.title.trim() || 'Аудиокнига'
  if (o.partsMode === 'perChapter' && part.chapters[0]) return `${title} — ${part.chapters[0].title}`
  return `${title} (часть ${part.index + 1} из ${count})`
}

// ------------------------------------------------------------ segments

function segmentsOf(p: Project, part: PartPlan): Segment[] {
  const last = part.to ? part.to.fileIndex : p.files.length - 1
  const segs: Segment[] = []
  for (let i = part.from.fileIndex; i <= last; i++) {
    const from = i === part.from.fileIndex ? part.from.offset : 0
    const to = part.to && i === part.to.fileIndex ? part.to.offset : undefined
    if (to !== undefined && to - from < 0.001) continue
    segs.push({ file: p.files[i], fileIndex: i, from, to })
  }
  return segs
}

/** Chapters of a part, positioned with the real decoded durations of its segments. */
function partChapters(p: Project, part: PartPlan, segs: Segment[], durations: number[]): PartChapter[] {
  const segStart: number[] = []
  let acc = 0
  for (const d of durations) {
    segStart.push(acc)
    acc += d
  }
  const out: PartChapter[] = []
  for (const c of part.chapters) {
    const si = segs.findIndex((s) => s.file.id === c.fileId && c.offset >= s.from - 0.001 && (s.to === undefined || c.offset < s.to))
    if (si < 0) continue
    const start = Math.min(segStart[si] + c.offset - segs[si].from, acc)
    out.push({ start, title: c.title, image: c.image })
  }
  // A part that starts inside a chapter continues it.
  if (part.index > 0 && (!out.length || out[0].start > 0.5)) {
    const covering = timeline(p).filter((c) => c.start < part.start + 0.001).pop()
    if (covering) out.unshift({ start: 0, title: `${covering.title} (продолжение)`, image: covering.image })
  }
  if (out.length) out[0].start = 0
  return out.filter((c, i) => i === 0 || c.start > out[i - 1].start + 0.001)
}

// ------------------------------------------------------------ audio

interface AudioResult {
  durations: number[] // per segment, seconds
  total: number
}

function encoderArgs(o: BuildOptions, appleAac: boolean): string[] {
  if (appleAac) {
    const args = ['-c:a', 'aac_at', '-b:a', `${o.bitrate}k`, '-aac_at_mode', 'cvbr']
    if (o.encoder === 'he-aac') args.push('-profile:a', '4') // AV_PROFILE_AAC_HE
    return args
  }
  return ['-c:a', 'aac', '-b:a', `${o.bitrate}k`]
}

function watchExit(p: ChildProcess, name: string): Promise<void> {
  const err: Buffer[] = []
  p.stderr!.on('data', (d: Buffer) => err.push(d))
  return new Promise((resolve, reject) => {
    p.on('error', (e) => reject(new Error(`${name}: ${e.message}`)))
    p.on('close', (code, sig) => {
      if (code === 0) resolve()
      else reject(new Error(`${name}: ${lastLines(Buffer.concat(err).toString('utf8')) || `код ${code ?? sig}`}`))
    })
  })
}

async function encodeAudio(
  segs: Segment[],
  out: string,
  o: BuildOptions,
  appleAac: boolean,
  progress: Progress,
  part: PartPlan,
  signal?: AbortSignal,
): Promise<AudioResult> {
  const rate = o.sampleRate
  const ch = o.channels
  const frame = 2 * ch
  const enc = spawnTool('ffmpeg', [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-f', 's16le', '-ar', String(rate), '-ac', String(ch), '-i', 'pipe:0',
    ...encoderArgs(o, appleAac),
    '-f', 'mp4', '-y', out,
  ])
  enc.stdout!.resume()
  const encDone = watchExit(enc, 'Кодировщик')
  let encFailed: unknown
  encDone.catch((e) => (encFailed = e))
  enc.stdin!.on('error', () => {}) // surfaced through encDone

  let current: ChildProcess | undefined
  const onAbort = () => {
    current?.kill('SIGKILL')
    enc.kill('SIGKILL')
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const durations: number[] = []
  try {
    for (const s of segs) {
      if (signal?.aborted) throw new AbortError()
      progress.emit('encode', part.index + 1, `Кодирование: ${s.file.name}`)
      const args = ['-hide_banner', '-v', 'error', '-nostdin']
      if (s.from > 0) args.push('-ss', s.from.toFixed(6))
      args.push('-i', s.file.path)
      if (s.to !== undefined) args.push('-t', (s.to - s.from).toFixed(6))
      args.push('-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', String(ch), '-ar', String(rate), '-f', 's16le', 'pipe:1')
      const dec = spawnTool('ffmpeg', args)
      current = dec
      const decDone = watchExit(dec, s.file.name)
      decDone.catch(() => {})
      let bytes = 0
      let carry = 0
      for await (const chunk of dec.stdout! as AsyncIterable<Buffer>) {
        if (encFailed) throw encFailed
        bytes += chunk.length
        if (!enc.stdin!.write(chunk)) {
          await Promise.race([once(enc.stdin!, 'drain'), encDone])
        }
        carry += chunk.length
        if (carry > rate * frame) {
          progress.advance('encode', carry / frame / rate)
          carry = 0
        }
      }
      progress.advance('encode', carry / frame / rate)
      await decDone
      durations.push(Math.floor(bytes / frame) / rate)
    }
    enc.stdin!.end()
    await encDone
  } catch (e) {
    enc.kill('SIGKILL')
    current?.kill('SIGKILL')
    if (signal?.aborted) throw new AbortError()
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return { durations, total: durations.reduce((a, b) => a + b, 0) }
}

function concatLine(path: string): string {
  return `file '${path.replaceAll("'", "'\\''")}'`
}

async function runWithProgress(
  args: string[],
  name: string,
  onSeconds: (s: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const p = spawnTool('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-progress', 'pipe:1', '-stats_period', '0.5', ...args])
  const done = watchExit(p, name)
  const onAbort = () => p.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })
  let buf = ''
  p.stdout!.on('data', (d: Buffer) => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const l of lines) {
      const m = /^out_time_us=(\d+)/.exec(l)
      if (m) onSeconds(Number(m[1]) / 1e6)
    }
  })
  try {
    await done
  } catch (e) {
    if (signal?.aborted) throw new AbortError()
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function copyAudio(segs: Segment[], out: string, progress: Progress, part: PartPlan, signal?: AbortSignal): Promise<AudioResult> {
  const list = `${out}.txt`
  await writeFile(list, `ffconcat version 1.0\n${segs.map((s) => concatLine(s.file.path)).join('\n')}\n`, 'utf8')
  progress.emit('encode', part.index + 1, 'Склейка без перекодирования')
  let last = 0
  try {
    await runWithProgress(
      ['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:a', '-c', 'copy', '-f', 'mp4', '-y', out],
      'Склейка',
      (s) => {
        progress.advance('encode', Math.max(0, s - last))
        last = Math.max(last, s)
      },
      signal,
    )
  } finally {
    await rm(list, { force: true })
  }
  const durations = segs.map((s) => s.file.duration)
  return { durations, total: durations.reduce((a, b) => a + b, 0) }
}

// ------------------------------------------------------------ chapters mux

function escapeMeta(s: string): string {
  return s.replace(/[\\=;#\n]/g, (c) => (c === '\n' ? ' ' : `\\${c}`))
}

async function mux(
  audio: string,
  out: string,
  chapters: PartChapter[],
  tmp: string,
  total: number,
  progress: Progress,
  part: PartPlan,
  signal?: AbortSignal,
): Promise<void> {
  progress.emit('mux', part.index + 1, chapters.length ? 'Запись глав' : 'Упаковка')
  const args = ['-i', audio]
  if (chapters.length) {
    const meta = [';FFMETADATA1']
    chapters.forEach((c, i) => {
      const end = i + 1 < chapters.length ? chapters[i + 1].start : total
      meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${escapeMeta(c.title)}`)
    })
    const metaFile = join(tmp, `chapters-${part.index}.txt`)
    await writeFile(metaFile, meta.join('\n') + '\n', 'utf8')
    args.push('-f', 'ffmetadata', '-i', metaFile, '-map_chapters', '1')
  }
  args.push('-map', '0:a', '-c', 'copy', '-f', 'ipod', '-y', out)
  let last = 0
  await runWithProgress(args, 'Упаковка', (s) => {
    progress.advance('mux', Math.max(0, s - last))
    last = Math.max(last, s)
  }, signal)
}

// ------------------------------------------------------------ artwork

interface Art {
  cover?: { data: Buffer; format: 'jpeg' | 'png' }
  chapterImages: boolean
  normalized: Map<string, Buffer> // source path → square JPEG
  fallback?: Buffer
}

function imageFormat(b: Buffer): 'jpeg' | 'png' | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  return undefined
}

async function ffImage(src: string, dst: string, vf: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    await runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', '-y', dst], signal)
  } catch (e) {
    if (e instanceof AbortError) throw e
    throw new Error(`Не удалось прочитать картинку ${src}`)
  }
  return readFile(dst)
}

async function prepareArt(p: Project, o: BuildOptions, tmp: string, signal?: AbortSignal): Promise<Art> {
  const art: Art = { chapterImages: p.chapters.some((c) => c.image), normalized: new Map() }
  if (p.meta.cover) {
    const raw = await readFile(p.meta.cover).catch(() => {
      throw new Error(`Обложка не найдена: ${p.meta.cover}`)
    })
    const fmt = imageFormat(raw)
    if (fmt && raw.length <= 4e6) art.cover = { data: raw, format: fmt }
    else {
      const data = await ffImage(p.meta.cover, join(tmp, 'cover.jpg'), "scale='min(1400,iw)':-2:flags=lanczos,format=yuvj420p", signal)
      art.cover = { data, format: 'jpeg' }
    }
  }
  if (art.chapterImages) {
    const size = o.chapterImageSize
    const bg = o.chapterImageBackground.replace('#', '0x')
    const vf = `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=${bg},format=yuvj420p`
    const sources = [...new Set(p.chapters.map((c) => c.image).filter((x): x is string => !!x))]
    let i = 0
    for (const src of sources) art.normalized.set(src, await ffImage(src, join(tmp, `ch-${i++}.jpg`), vf, signal))
    if (p.meta.cover) art.fallback = await ffImage(p.meta.cover, join(tmp, 'ch-cover.jpg'), vf, signal)
    else {
      await runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${bg}:s=${size}x${size}`, '-frames:v', '1', '-y', join(tmp, 'ch-blank.jpg')], signal)
      art.fallback = await readFile(join(tmp, 'ch-blank.jpg'))
    }
  }
  return art
}

function chapterImagesFor(chapters: PartChapter[], art: Art, o: BuildOptions): ChapterImages | undefined {
  if (!chapters.length) return undefined
  return {
    width: o.chapterImageSize,
    height: o.chapterImageSize,
    images: chapters.map((c) => (c.image && art.normalized.get(c.image)) || art.fallback!),
  }
}

// ------------------------------------------------------------ progress

class Progress {
  private total: number
  private done = 0
  private started = Date.now()
  private lastEmit = 0
  private lastStage = ''
  private lastMessage = ''
  private stage: BuildProgress['stage'] = 'prepare'
  private part = 1
  private parts: PartPlan[]
  private weights: { encode: number; mux: number }
  private cb?: (p: BuildProgress) => void

  constructor(parts: PartPlan[], passthrough: boolean, cb?: (p: BuildProgress) => void) {
    this.parts = parts
    this.cb = cb
    this.weights = passthrough ? { encode: 1, mux: 1 } : { encode: 1, mux: 0.04 }
    this.total = parts.reduce((a, p) => a + (p.end - p.start) * (this.weights.encode + this.weights.mux), 0) || 1
  }

  advance(stage: 'encode' | 'mux', seconds: number): void {
    this.done += seconds * this.weights[stage]
    this.emit(stage, this.part, this.lastMessage)
  }

  partDone(part: PartPlan): void {
    const target = this.parts.slice(0, part.index + 1).reduce((a, p) => a + (p.end - p.start) * (this.weights.encode + this.weights.mux), 0)
    this.done = Math.max(this.done, target)
  }

  emit(stage: BuildProgress['stage'], part: number, message: string, fraction?: number): void {
    this.stage = stage
    this.part = part
    const changed = stage !== this.lastStage || message !== this.lastMessage
    this.lastStage = stage
    this.lastMessage = message
    const now = Date.now()
    if (fraction === undefined && !changed && now - this.lastEmit < 200) return
    this.lastEmit = now
    const f = fraction ?? Math.min(0.999, this.done / this.total)
    const elapsed = (now - this.started) / 1000
    const eta = f > 0.02 && f < 1 ? (elapsed / f) * (1 - f) : undefined
    this.cb?.({ stage: this.stage, part: this.part, parts: this.parts.length, fraction: f, etaSeconds: eta, message })
  }
}
