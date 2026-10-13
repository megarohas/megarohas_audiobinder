// Project model shared by the core, the main process and the UI.

export interface SourceFile {
  id: string
  path: string
  name: string // display name, also the default chapter title
  duration: number // seconds
  codec: string // ffprobe codec_name, e.g. 'mp3', 'aac'
  profile: string // codec profile, e.g. 'LC', 'HE-AAC'
  container: string // ffprobe format_name
  sampleRate: number
  channels: number
  bitRate: number // bps, 0 when unknown
  tags: Record<string, string> // lower-cased ffprobe tags
}

/**
 * A chapter is anchored to a file and an offset inside it, so reordering
 * files carries their chapters along.
 */
export interface Chapter {
  id: string
  fileId: string
  offset: number // seconds from the start of that file
  title: string
  image?: string // absolute path to an image file
}

export interface BookMeta {
  title: string
  author: string
  narrator: string
  genre: string
  year: string
  description: string
  copyright: string
  publisher: string
  comment: string
  lyrics: string
  encodedBy: string
  cover?: string // absolute path to an image file
}

export type TagTarget = 'artist' | 'albumArtist' | 'composer'
export type QualityPreset = 'low' | 'normal' | 'high' | 'custom'
export type PartsMode = 'none' | 'chapters' | 'files' | 'exact' | 'perChapter'

export interface BuildOptions {
  format: 'm4b' | 'm4a'
  preset: QualityPreset
  bitrate: number // kbps
  channels: 1 | 2
  sampleRate: number
  encoder: 'aac' | 'he-aac'
  passthrough: boolean // copy audio when every source is compatible AAC
  partsMode: PartsMode
  partHours: number // target part length for chapters/files/exact modes
  authorTags: TagTarget[]
  narratorTags: TagTarget[]
  chapterImageSize: number // px, square
  chapterImageBackground: string // CSS hex colour for letterboxing
}

export interface Project {
  version: 1
  meta: BookMeta
  files: SourceFile[]
  chapters: Chapter[]
  build: BuildOptions
}

export interface QualityValues {
  bitrate: number
  channels: 1 | 2
  sampleRate: number
}

export const QUALITY_PRESETS: Record<Exclude<QualityPreset, 'custom'>, QualityValues> = {
  low: { bitrate: 32, channels: 1, sampleRate: 22050 },
  normal: { bitrate: 64, channels: 1, sampleRate: 32000 },
  high: { bitrate: 128, channels: 2, sampleRate: 44100 },
}

export function defaultBuildOptions(): BuildOptions {
  return {
    format: 'm4b',
    preset: 'normal',
    ...QUALITY_PRESETS.normal,
    encoder: 'aac',
    passthrough: true,
    partsMode: 'none',
    partHours: 12,
    authorTags: ['artist', 'albumArtist'],
    narratorTags: ['composer'],
    chapterImageSize: 600,
    chapterImageBackground: '#000000',
  }
}

export function emptyMeta(): BookMeta {
  return {
    title: '',
    author: '',
    narrator: '',
    genre: '',
    year: '',
    description: '',
    copyright: '',
    publisher: '',
    comment: '',
    lyrics: '',
    encodedBy: '',
  }
}

export function emptyProject(build: BuildOptions = defaultBuildOptions()): Project {
  return { version: 1, meta: emptyMeta(), files: [], chapters: [], build }
}

export interface BuildProgress {
  stage: 'prepare' | 'encode' | 'mux' | 'finalize' | 'done'
  part: number // 1-based
  parts: number
  fraction: number // 0..1 overall
  etaSeconds?: number
  message: string
}

export interface BuildResult {
  outputs: string[]
  seconds: number
  passthrough: boolean
}
