// Importing an existing audiobook (M4B/M4A/MP3 with chapters) for re-editing.

import { open, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { newChapter } from './chapters.ts'
import { runTool } from './ffmpeg.ts'
import { child, getTags, path as boxPath, readHandler, readMdhdTimescale, readMoov, readSttsDurations, readTkhdId, type Box } from './mp4.ts'
import { probeFile } from './probe.ts'
import { emptyMeta, type BookMeta, type Chapter, type SourceFile } from './types.ts'

export interface ImportedBook {
  meta: BookMeta
  file: SourceFile
  chapters: Chapter[]
  warnings: string[]
}

function imageExt(b: Buffer): string {
  return b[0] === 0x89 && b[1] === 0x50 ? 'png' : 'jpg'
}

async function saveImage(dir: string, data: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true })
  const p = join(dir, `${crypto.randomUUID()}.${imageExt(data)}`)
  await writeFile(p, data)
  return p
}

/** Byte ranges of every sample in a track, from stsz/stsc/stco|co64. */
function sampleRanges(trak: Box): { offset: number; size: number }[] {
  const stbl = boxPath(trak, 'mdia', 'minf', 'stbl')!
  const stsz = child(stbl, 'stsz')!.data!
  const fixed = stsz.readUInt32BE(4)
  const count = stsz.readUInt32BE(8)
  const sizes = Array.from({ length: count }, (_, i) => (fixed || stsz.readUInt32BE(12 + i * 4)))
  const stsc = child(stbl, 'stsc')!.data!
  const runs = Array.from({ length: stsc.readUInt32BE(4) }, (_, i) => ({
    first: stsc.readUInt32BE(8 + i * 12),
    per: stsc.readUInt32BE(12 + i * 12),
  }))
  const co = child(stbl, 'stco') ?? child(stbl, 'co64')!
  const wide = co.type === 'co64'
  const nChunks = co.data!.readUInt32BE(4)
  const chunkOffset = (i: number) => (wide ? Number(co.data!.readBigUInt64BE(8 + i * 8)) : co.data!.readUInt32BE(8 + i * 4))
  const out: { offset: number; size: number }[] = []
  let s = 0
  for (let c = 0; c < nChunks && s < count; c++) {
    const run = [...runs].reverse().find((r) => r.first <= c + 1)
    let pos = chunkOffset(c)
    for (let k = 0; k < (run?.per ?? 1) && s < count; k++) {
      out.push({ offset: pos, size: sizes[s] })
      pos += sizes[s++]
    }
  }
  return out
}

/** Extracts QuickTime chapter images: [startSeconds, jpegBytes][] */
async function extractChapterImages(file: string, moov: Box): Promise<{ start: number; data: Buffer }[]> {
  const traks = moov.children!.filter((c) => c.type === 'trak')
  const audio = traks.find((t) => readHandler(t) === 'soun')
  const chap = audio && boxPath(audio, 'tref', 'chap')
  if (!chap?.data) return []
  const ids = Array.from({ length: chap.data.length / 4 }, (_, i) => chap.data!.readUInt32BE(i * 4))
  const video = traks.find((t) => ids.includes(readTkhdId(child(t, 'tkhd')!)) && readHandler(t) === 'vide')
  if (!video) return []
  const scale = readMdhdTimescale(boxPath(video, 'mdia', 'mdhd')!)
  const durations = readSttsDurations(boxPath(video, 'mdia', 'minf', 'stbl', 'stts')!)
  const ranges = sampleRanges(video)
  const fh = await open(file, 'r')
  try {
    const out: { start: number; data: Buffer }[] = []
    let t = 0
    for (let i = 0; i < ranges.length; i++) {
      const buf = Buffer.alloc(ranges[i].size)
      await fh.read(buf, 0, buf.length, ranges[i].offset)
      out.push({ start: t / scale, data: buf })
      t += durations[i] ?? 0
    }
    return out
  } finally {
    await fh.close()
  }
}

const MP4_EXT = /\.(m4b|m4a|mp4|aac)$/i

export async function importBook(path: string, cacheDir: string): Promise<ImportedBook> {
  const warnings: string[] = []
  const { file, chapters: probed } = await probeFile(path, 'tag')
  const meta = emptyMeta()
  const t = file.tags
  meta.title = t.album || t.title || ''
  meta.author = t.artist || t.album_artist || ''
  meta.narrator = t.composer || ''
  meta.genre = t.genre || ''
  meta.year = (t.date || t.year || '').slice(0, 4)
  meta.description = t.synopsis || t.description || ''
  meta.copyright = t.copyright || ''
  meta.comment = t.comment || ''
  meta.lyrics = t.lyrics || ''
  meta.publisher = t.publisher || ''
  meta.encodedBy = t.encoded_by || ''

  let images: { start: number; data: Buffer }[] = []
  if (MP4_EXT.test(path) && /mp4|mov/.test(file.container)) {
    try {
      const moov = await readMoov(path)
      const { text, cover } = getTags(moov)
      meta.title = text['©alb'] || text['©nam'] || meta.title
      meta.author = text['©ART'] || text['aART'] || meta.author
      meta.narrator = text['©nrt'] || text['©wrt'] || meta.narrator
      meta.genre = text['©gen'] || meta.genre
      meta.year = (text['©day'] || meta.year).slice(0, 4)
      meta.description = text['ldes'] || text['desc'] || meta.description
      meta.copyright = text['cprt'] || meta.copyright
      meta.publisher = text['©pub'] || meta.publisher
      meta.comment = text['©cmt'] || meta.comment
      meta.lyrics = text['©lyr'] || meta.lyrics
      meta.encodedBy = text['©enc'] || meta.encodedBy
      if (cover) meta.cover = await saveImage(cacheDir, cover.data)
      images = await extractChapterImages(path, moov)
    } catch (e) {
      warnings.push(`Не все теги удалось прочитать: ${(e as Error).message}`)
    }
  }
  if (!meta.cover) {
    const out = join(cacheDir, `${crypto.randomUUID()}.jpg`)
    await mkdir(cacheDir, { recursive: true })
    const ok = await runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-y', out])
      .then(() => true)
      .catch(() => false)
    if (ok) meta.cover = out
  }

  const chapters: Chapter[] = []
  for (const [i, c] of probed.entries()) {
    const img = [...images].reverse().find((x) => x.start <= c.start + 0.5)
    const image = img && images.length > 1 ? await saveImage(cacheDir, img.data) : undefined
    chapters.push(newChapter(file.id, Math.max(0, c.start), c.title || `Глава ${i + 1}`, image))
  }
  if (!chapters.length) chapters.push(newChapter(file.id, 0, meta.title || file.name))
  // Distinct images only: identical bytes would have been the cover fallback.
  if (images.length && new Set(images.map((x) => x.data.toString('base64'))).size === 1) {
    for (const c of chapters) delete c.image
  }
  return { meta, file, chapters, warnings }
}
