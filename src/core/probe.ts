// Reading audio files: durations, formats, tags, embedded chapters.

import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runTool } from './ffmpeg.ts'
import type { SourceFile } from './types.ts'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.flac', '.wav', '.aif', '.aiff', '.aifc', '.caf',
  '.ogg', '.oga', '.opus', '.wma', '.ac3', '.mka', '.ape', '.wv', '.amr', '.webm', '.mp2',
])

const DRM_EXTENSIONS = new Set(['.aa', '.aax', '.aaxc'])

export interface ProbeChapter {
  start: number
  end: number
  title: string
}

export interface ProbeResult {
  file: SourceFile
  chapters: ProbeChapter[]
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    profile?: string
    sample_rate?: string
    channels?: number
    bit_rate?: string
    duration?: string
    disposition?: { attached_pic?: number }
    tags?: Record<string, string>
  }>
  chapters?: Array<{ start_time?: string; end_time?: string; tags?: Record<string, string> }>
}

function lowerKeys(o: Record<string, string> | undefined): Record<string, string> {
  const r: Record<string, string> = {}
  for (const [k, v] of Object.entries(o ?? {})) r[k.toLowerCase()] = v
  return r
}

export type TitleSource = 'tag' | 'filename'

export async function probeFile(path: string, titleSource: TitleSource = 'tag'): Promise<ProbeResult> {
  const ext = extname(path).toLowerCase()
  if (DRM_EXTENSIONS.has(ext)) {
    throw new Error(`${basename(path)}: файлы Audible защищены DRM и не поддерживаются`)
  }
  let json: FfprobeJson
  try {
    const out = await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', path])
    json = JSON.parse(out.toString('utf8'))
  } catch (e) {
    throw new Error(`${basename(path)}: не удалось прочитать файл (${(e as Error).message.split('\n')[0]})`)
  }
  const audio = json.streams?.find((s) => s.codec_type === 'audio')
  if (!audio) throw new Error(`${basename(path)}: в файле нет звука`)
  const duration = Number(audio.duration ?? json.format?.duration ?? 0)
  if (!(duration > 0)) throw new Error(`${basename(path)}: не удалось определить длительность`)

  const tags = { ...lowerKeys(json.format?.tags), ...lowerKeys(audio.tags) }
  const stem = basename(path, extname(path))
  const name = (titleSource === 'tag' && tags.title?.trim()) || stem

  const file: SourceFile = {
    id: randomUUID(),
    path,
    name,
    duration,
    codec: audio.codec_name ?? '',
    profile: audio.profile ?? '',
    container: json.format?.format_name ?? '',
    sampleRate: Number(audio.sample_rate ?? 0),
    channels: audio.channels ?? 0,
    bitRate: Number(audio.bit_rate ?? json.format?.bit_rate ?? 0),
    tags,
  }
  const chapters: ProbeChapter[] = (json.chapters ?? []).map((c, i) => ({
    start: Number(c.start_time ?? 0),
    end: Number(c.end_time ?? 0),
    title: c.tags?.title ?? `Глава ${i + 1}`,
  }))
  return { file, chapters }
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b)
}

/** Expands dropped paths: folders are walked recursively, audio files kept, sorted naturally. */
export async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    const st = await stat(p).catch(() => undefined)
    if (!st) continue
    if (st.isDirectory()) out.push(...(await walk(p)))
    else if (AUDIO_EXTENSIONS.has(extname(p).toLowerCase()) || DRM_EXTENSIONS.has(extname(p).toLowerCase())) out.push(p)
  }
  return out
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => naturalCompare(a.name, b.name))
  const out: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase())) out.push(full)
  }
  return out
}

/** Probes many files with limited parallelism, keeping order; failures are collected. */
export async function probeMany(
  paths: string[],
  titleSource: TitleSource,
  onProgress?: (done: number, total: number) => void,
): Promise<{ results: ProbeResult[]; errors: string[] }> {
  const results: (ProbeResult | undefined)[] = new Array(paths.length)
  const errors: string[] = []
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < paths.length) {
      const i = next++
      try {
        results[i] = await probeFile(paths[i], titleSource)
      } catch (e) {
        errors.push((e as Error).message)
      }
      onProgress?.(++done, paths.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, worker))
  return { results: results.filter((r): r is ProbeResult => !!r), errors }
}
