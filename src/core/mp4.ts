// Minimal ISO-BMFF (MP4) box toolkit: parse the moov tree, edit it, and
// write it back. Used to finalize ffmpeg output with iTunes tags, cover art
// and a QuickTime chapter-image track, which ffmpeg cannot write itself.

import { open, truncate } from 'node:fs/promises'

export interface Box {
  type: string // 4 chars, latin1 (so '©nam' round-trips)
  data?: Buffer // payload for leaf boxes
  prefix?: Buffer // bytes before children in container-ish boxes (meta version/flags)
  children?: Box[]
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'tref', 'ilst'])

export function parseBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let header = 8
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) throw new Error(`Повреждённый MP4: атом ${type} выходит за границы`)
    const bodyStart = pos + header
    const bodyEnd = pos + size
    if (CONTAINERS.has(type)) {
      out.push({ type, children: parseBoxes(buf, bodyStart, bodyEnd) })
    } else if (type === 'meta') {
      // ISO meta is a FullBox (4 bytes version/flags); QuickTime meta is not.
      const isQt = buf.toString('latin1', bodyStart + 4, bodyStart + 8) === 'hdlr'
      const prefixLen = isQt ? 0 : 4
      out.push({
        type,
        prefix: Buffer.from(buf.subarray(bodyStart, bodyStart + prefixLen)),
        children: parseBoxes(buf, bodyStart + prefixLen, bodyEnd),
      })
    } else {
      out.push({ type, data: Buffer.from(buf.subarray(bodyStart, bodyEnd)) })
    }
    pos = bodyEnd
  }
  return out
}

export function serializeBox(box: Box): Buffer {
  const parts: Buffer[] = []
  if (box.prefix) parts.push(box.prefix)
  if (box.children) for (const c of box.children) parts.push(serializeBox(c))
  else if (box.data) parts.push(box.data)
  const body = Buffer.concat(parts)
  return Buffer.concat([boxHeader(box.type, body.length), body])
}

function boxHeader(type: string, bodyLen: number): Buffer {
  const total = bodyLen + 8
  if (total > 0xffffffff) {
    const h = Buffer.alloc(16)
    h.writeUInt32BE(1, 0)
    h.write(type, 4, 'latin1')
    h.writeBigUInt64BE(BigInt(bodyLen + 16), 8)
    return h
  }
  const h = Buffer.alloc(8)
  h.writeUInt32BE(total, 0)
  h.write(type, 4, 'latin1')
  return h
}

export function leaf(type: string, data: Buffer): Box {
  return { type, data }
}

export function container(type: string, children: Box[]): Box {
  return { type, children }
}

export function child(box: Box, type: string): Box | undefined {
  return box.children?.find((c) => c.type === type)
}

export function path(box: Box, ...types: string[]): Box | undefined {
  let cur: Box | undefined = box
  for (const t of types) cur = cur && child(cur, t)
  return cur
}

// ---------------------------------------------------------------- top level

export interface TopBox {
  type: string
  offset: number
  size: number
  header: number
}

export async function scanTopLevel(file: string): Promise<{ boxes: TopBox[]; fileSize: number }> {
  const fh = await open(file, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const boxes: TopBox[] = []
    const hdr = Buffer.alloc(16)
    let pos = 0
    while (pos + 8 <= fileSize) {
      await fh.read(hdr, 0, 16, pos)
      let size = hdr.readUInt32BE(0)
      const type = hdr.toString('latin1', 4, 8)
      let header = 8
      if (size === 1) {
        size = Number(hdr.readBigUInt64BE(8))
        header = 16
      } else if (size === 0) size = fileSize - pos
      if (size < header) throw new Error(`Повреждённый MP4 около байта ${pos}`)
      boxes.push({ type, offset: pos, size, header })
      pos += size
    }
    return { boxes, fileSize }
  } finally {
    await fh.close()
  }
}

// ------------------------------------------------------------- full boxes

function fullHeader(version: number, flags: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0)
  return b
}

function u32(...vals: number[]): Buffer {
  const b = Buffer.alloc(vals.length * 4)
  vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4))
  return b
}

function u64(v: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(v), 0)
  return b
}

const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)

export function readMvhd(mvhd: Box): { timescale: number; duration: number; nextTrackIdOffset: number } {
  const d = mvhd.data!
  const v = d[0]
  if (v === 1) return { timescale: d.readUInt32BE(20), duration: Number(d.readBigUInt64BE(24)), nextTrackIdOffset: 108 }
  return { timescale: d.readUInt32BE(12), duration: d.readUInt32BE(16), nextTrackIdOffset: 96 }
}

export function readMdhdTimescale(mdhd: Box): number {
  const d = mdhd.data!
  return d[0] === 1 ? d.readUInt32BE(20) : d.readUInt32BE(12)
}

export function readTkhdId(tkhd: Box): number {
  const d = tkhd.data!
  return d[0] === 1 ? d.readUInt32BE(20) : d.readUInt32BE(12)
}

export function readHandler(trak: Box): string {
  const hdlr = path(trak, 'mdia', 'hdlr')
  return hdlr?.data ? hdlr.data.toString('latin1', 8, 12) : ''
}

/** Expanded per-sample durations from an stts box. */
export function readSttsDurations(stts: Box): number[] {
  const d = stts.data!
  const n = d.readUInt32BE(4)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const count = d.readUInt32BE(8 + i * 8)
    const delta = d.readUInt32BE(12 + i * 8)
    for (let k = 0; k < count; k++) out.push(delta)
  }
  return out
}

function sttsBox(durations: number[]): Box {
  const runs: [number, number][] = []
  for (const d of durations) {
    const last = runs[runs.length - 1]
    if (last && last[1] === d) last[0]++
    else runs.push([1, d])
  }
  return leaf('stts', Buffer.concat([fullHeader(0, 0), u32(runs.length), ...runs.map(([c, d]) => u32(c, d))]))
}

// ------------------------------------------------------------- iTunes tags

export type TagValue =
  | { kind: 'text'; value: string }
  | { kind: 'int8'; value: number }
  | { kind: 'image'; value: Buffer; format: 'jpeg' | 'png' }
  | { kind: 'pair'; n: number; of: number } // trkn / disk

export interface Tag {
  atom: string // e.g. '©nam', 'aART', 'stik', 'covr'
  value: TagValue
}

function dataAtom(v: TagValue): Box {
  let typeCode: number
  let payload: Buffer
  if (v.kind === 'text') {
    typeCode = 1
    payload = Buffer.from(v.value, 'utf8')
  } else if (v.kind === 'int8') {
    typeCode = 21
    payload = Buffer.from([v.value & 0xff])
  } else if (v.kind === 'pair') {
    typeCode = 0
    payload = Buffer.alloc(8)
    payload.writeUInt16BE(v.n, 2)
    payload.writeUInt16BE(v.of, 4)
  } else {
    typeCode = v.format === 'png' ? 14 : 13
    payload = v.value
  }
  return leaf('data', Buffer.concat([u32(typeCode, 0), payload]))
}

export function buildIlst(tags: Tag[]): Box {
  const items = new Map<string, Box>()
  for (const t of tags) {
    if (t.value.kind === 'text' && t.value.value === '') continue
    const existing = items.get(t.atom)
    if (existing && t.atom === 'covr') existing.children!.push(dataAtom(t.value))
    else items.set(t.atom, container(t.atom, [dataAtom(t.value)]))
  }
  return container('ilst', [...items.values()])
}

function metaBox(ilst: Box): Box {
  const hdlr = leaf('hdlr', Buffer.concat([fullHeader(0, 0), u32(0), Buffer.from('mdirappl', 'latin1'), u32(0, 0), Buffer.from([0])]))
  return { type: 'meta', prefix: fullHeader(0, 0), children: [hdlr, ilst] }
}

export function setTags(moov: Box, tags: Tag[]): void {
  let udta = child(moov, 'udta')
  if (!udta) {
    udta = container('udta', [])
    moov.children!.push(udta)
  }
  const ilst = buildIlst(tags)
  const meta = child(udta, 'meta')
  if (meta) {
    const i = meta.children!.findIndex((c) => c.type === 'ilst')
    if (i >= 0) meta.children![i] = ilst
    else meta.children!.push(ilst)
  } else {
    udta.children!.push(metaBox(ilst))
  }
}

/** Reads iTunes text tags (and cover) from a parsed moov. */
export function getTags(moov: Box): { text: Record<string, string>; cover?: { data: Buffer; format: 'jpeg' | 'png' } } {
  const text: Record<string, string> = {}
  let cover: { data: Buffer; format: 'jpeg' | 'png' } | undefined
  const ilst = path(moov, 'udta', 'meta', 'ilst')
  for (const item of ilst?.children ?? []) {
    const kids = item.children ?? parseBoxes(item.data!)
    const data = kids.find((c) => c.type === 'data')?.data
    if (!data || data.length < 8) continue
    const code = data.readUInt32BE(0) & 0xffffff
    const payload = data.subarray(8)
    if (item.type === 'covr' && !cover) cover = { data: Buffer.from(payload), format: code === 14 ? 'png' : 'jpeg' }
    else if (code === 1) text[item.type] = payload.toString('utf8')
  }
  return { text, cover }
}

// ------------------------------------------------- chapter image track

export interface ChapterImages {
  images: Buffer[] // JPEG, one per chapter sample, all width x height
  width: number
  height: number
}

interface PreparedImageTrack {
  trak: Box
  trackId: number
  stco: Box // patched once the mdat offset is known
  sizes: number[]
}

function buildImageTrack(moov: Box, textTrak: Box, imgs: ChapterImages): PreparedImageTrack {
  const mvhd = child(moov, 'mvhd')!
  const { timescale: movieScale, nextTrackIdOffset } = readMvhd(mvhd)
  const trackId = mvhd.data!.readUInt32BE(nextTrackIdOffset)
  mvhd.data!.writeUInt32BE(trackId + 1, nextTrackIdOffset)

  const textMdhd = path(textTrak, 'mdia', 'mdhd')!
  const timescale = readMdhdTimescale(textMdhd)
  const durations = readSttsDurations(path(textTrak, 'mdia', 'minf', 'stbl', 'stts')!)
  if (durations.length !== imgs.images.length) {
    throw new Error(`Картинок глав ${imgs.images.length}, а глав в файле ${durations.length}`)
  }
  const mediaDuration = durations.reduce((a, b) => a + b, 0)
  const movieDuration = Math.round((mediaDuration * movieScale) / timescale)
  const big = mediaDuration > 0xffffffff || movieDuration > 0xffffffff

  // tkhd: in movie, but disabled — players use it only through the chap reference.
  const tkhd = big
    ? Buffer.concat([fullHeader(1, 2), u64(0), u64(0), u32(trackId, 0), u64(movieDuration)])
    : Buffer.concat([fullHeader(0, 2), u32(0, 0, trackId, 0, movieDuration)])
  const tkhdTail = Buffer.concat([
    u32(0, 0), // reserved
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // layer, alternate_group, volume, reserved
    MATRIX,
    u32(imgs.width << 16, imgs.height << 16),
  ])

  const mdhd = big
    ? Buffer.concat([fullHeader(1, 0), u64(0), u64(0), u32(timescale), u64(mediaDuration)])
    : Buffer.concat([fullHeader(0, 0), u32(0, 0, timescale, mediaDuration)])
  const mdhdTail = Buffer.from([0x55, 0xc4, 0, 0]) // 'und', pre_defined

  const hdlr = Buffer.concat([fullHeader(0, 0), u32(0), Buffer.from('vide', 'latin1'), u32(0, 0, 0), Buffer.from('Chapter Images\0', 'latin1')])

  const sampleEntry = Buffer.alloc(78)
  sampleEntry.writeUInt16BE(1, 6) // data_reference_index
  sampleEntry.writeUInt16BE(imgs.width, 24)
  sampleEntry.writeUInt16BE(imgs.height, 26)
  sampleEntry.writeUInt32BE(0x00480000, 28)
  sampleEntry.writeUInt32BE(0x00480000, 32)
  sampleEntry.writeUInt16BE(1, 40) // frame_count
  const name = 'Photo - JPEG'
  sampleEntry[42] = name.length
  sampleEntry.write(name, 43, 'latin1')
  sampleEntry.writeUInt16BE(0x0018, 74) // depth
  sampleEntry.writeInt16BE(-1, 76)
  const stsd = leaf('stsd', Buffer.concat([fullHeader(0, 0), u32(1), serializeBox(leaf('jpeg', sampleEntry))]))

  const sizes = imgs.images.map((b) => b.length)
  const stsc = leaf('stsc', Buffer.concat([fullHeader(0, 0), u32(1, 1, 1, 1)]))
  const stsz = leaf('stsz', Buffer.concat([fullHeader(0, 0), u32(0, sizes.length), ...sizes.map((s) => u32(s))]))
  const stco: Box = leaf('stco', Buffer.alloc(0)) // filled by patchChunkOffsets

  const trak = container('trak', [
    leaf('tkhd', Buffer.concat([tkhd, tkhdTail])),
    container('mdia', [
      leaf('mdhd', Buffer.concat([mdhd, mdhdTail])),
      leaf('hdlr', hdlr),
      container('minf', [
        leaf('vmhd', Buffer.concat([fullHeader(0, 1), Buffer.alloc(8)])),
        container('dinf', [leaf('dref', Buffer.concat([fullHeader(0, 0), u32(1), serializeBox(leaf('url ', fullHeader(0, 1)))]))]),
        container('stbl', [stsd, sttsBox(durations), stsc, stsz, stco]),
      ]),
    ]),
  ])
  return { trak, trackId, stco, sizes }
}

function patchChunkOffsets(prep: PreparedImageTrack, payloadStart: number): void {
  const offsets: number[] = []
  let pos = payloadStart
  for (const s of prep.sizes) {
    offsets.push(pos)
    pos += s
  }
  if (pos > 0xffffffff) {
    prep.stco.type = 'co64'
    prep.stco.data = Buffer.concat([fullHeader(0, 0), u32(offsets.length), ...offsets.map(u64)])
  } else {
    prep.stco.type = 'stco'
    prep.stco.data = Buffer.concat([fullHeader(0, 0), u32(offsets.length), ...offsets.map((o) => u32(o))])
  }
}

function findTracks(moov: Box): { audio: Box; textChapters?: Box } {
  const traks = moov.children!.filter((c) => c.type === 'trak')
  const audio = traks.find((t) => readHandler(t) === 'soun')
  if (!audio) throw new Error('В файле нет аудиодорожки')
  const chap = path(audio, 'tref', 'chap')
  const ids = chap?.data ? Array.from({ length: chap.data.length / 4 }, (_, i) => chap.data!.readUInt32BE(i * 4)) : []
  const textChapters = traks.find((t) => ids.includes(readTkhdId(child(t, 'tkhd')!)) && readHandler(t) === 'text')
  return { audio, textChapters }
}

function addChapterReference(audio: Box, trackId: number): void {
  let tref = child(audio, 'tref')
  if (!tref) {
    tref = container('tref', [])
    audio.children!.splice(1, 0, tref)
  }
  const chap = child(tref, 'chap')
  if (chap) chap.data = Buffer.concat([chap.data!, u32(trackId)])
  else tref.children!.push(leaf('chap', u32(trackId)))
}

// ------------------------------------------------------------- finalize

export interface FinalizeOptions {
  tags?: Tag[]
  chapterImages?: ChapterImages
  majorBrand?: string // e.g. 'M4B '
}

/**
 * Rewrites the moov of an MP4 in place: replaces iTunes tags, optionally adds a
 * chapter-image track, and appends the new moov at the end. Audio data is never
 * moved, so this costs only a few writes even for multi-gigabyte books.
 */
export async function finalizeMp4(file: string, opts: FinalizeOptions): Promise<void> {
  const { boxes, fileSize } = await scanTopLevel(file)
  const moovTop = boxes.find((b) => b.type === 'moov')
  if (!moovTop) throw new Error('В файле нет атома moov')
  const ftypTop = boxes.find((b) => b.type === 'ftyp')

  const fh = await open(file, 'r+')
  try {
    const moovBuf = Buffer.alloc(moovTop.size)
    await fh.read(moovBuf, 0, moovTop.size, moovTop.offset)
    const [moov] = parseBoxes(moovBuf)

    if (opts.majorBrand && ftypTop) {
      const b = Buffer.from(opts.majorBrand.padEnd(4).slice(0, 4), 'latin1')
      await fh.write(b, 0, 4, ftypTop.offset + ftypTop.header)
    }

    if (opts.tags) setTags(moov, opts.tags)

    let imageTrack: PreparedImageTrack | undefined
    let imageData: Buffer | undefined
    if (opts.chapterImages && opts.chapterImages.images.length) {
      const { audio, textChapters } = findTracks(moov)
      if (!textChapters) throw new Error('В файле нет трека глав — картинки глав некуда привязать')
      imageTrack = buildImageTrack(moov, textChapters, opts.chapterImages)
      imageData = Buffer.concat(opts.chapterImages.images)
      addChapterReference(audio, imageTrack.trackId)
      // Keep the new trak right after the existing ones.
      const lastTrak = moov.children!.map((c) => c.type).lastIndexOf('trak')
      moov.children!.splice(lastTrak + 1, 0, imageTrack.trak)
    }

    // Where the new tail starts: drop the old moov if it is the last box,
    // otherwise neutralise it as 'free' so nothing before it moves.
    const moovIsLast = moovTop.offset + moovTop.size === fileSize
    let tailStart = fileSize
    if (moovIsLast) tailStart = moovTop.offset
    else await fh.write(Buffer.from('free', 'latin1'), 0, 4, moovTop.offset + 4)

    const tail: Buffer[] = []
    let pos = tailStart
    if (imageTrack && imageData) {
      const mdatHeader = boxHeader('mdat', imageData.length)
      patchChunkOffsets(imageTrack, pos + mdatHeader.length)
      tail.push(mdatHeader, imageData)
      pos += mdatHeader.length + imageData.length
    }
    tail.push(serializeBox(moov))
    const out = Buffer.concat(tail)
    await fh.write(out, 0, out.length, tailStart)
    await fh.close()
    await truncate(file, tailStart + out.length)
  } catch (e) {
    await fh.close().catch(() => {})
    throw e
  }
}

/** Reads the whole moov of a file (for import/inspection). */
export async function readMoov(file: string): Promise<Box> {
  const { boxes } = await scanTopLevel(file)
  const moovTop = boxes.find((b) => b.type === 'moov')
  if (!moovTop) throw new Error('В файле нет атома moov')
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(moovTop.size)
    await fh.read(buf, 0, moovTop.size, moovTop.offset)
    return parseBoxes(buf)[0]
  } finally {
    await fh.close()
  }
}
