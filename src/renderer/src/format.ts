import type { BuildOptions, SourceFile } from '../../core/types.ts'

export function humanDuration(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) return m ? `${h} ч ${m} мин` : `${h} ч`
  if (m) return r ? `${m} мин ${r} с` : `${m} мин`
  return `${r} с`
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

export function khz(rate: number): string {
  return `${(rate / 1000).toLocaleString('ru', { maximumFractionDigits: 2 })} кГц`
}

export function channelsLabel(n: number): string {
  return n === 1 ? 'моно' : n === 2 ? 'стерео' : `${n} кан.`
}

const CODEC_NAMES: Record<string, string> = {
  mp3: 'MP3', aac: 'AAC', flac: 'FLAC', alac: 'ALAC', opus: 'Opus', vorbis: 'Vorbis', wmav2: 'WMA', wmav1: 'WMA',
  ac3: 'AC-3', eac3: 'E-AC-3', ape: 'APE', wavpack: 'WavPack', amr_nb: 'AMR', mp2: 'MP2',
}

export function fileFormat(f: SourceFile): string {
  const codec = f.codec.startsWith('pcm_') ? 'PCM' : (CODEC_NAMES[f.codec] ?? f.codec.toUpperCase())
  const parts = [f.profile === 'HE-AAC' || f.profile === 'HE-AACv2' ? f.profile : codec]
  if (f.bitRate) parts.push(`${Math.round(f.bitRate / 1000)} кбит/с`)
  if (f.sampleRate) parts.push(khz(f.sampleRate))
  if (f.channels) parts.push(channelsLabel(f.channels))
  return parts.join(' · ')
}

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('ru', { maximumFractionDigits: 1 })} ГБ`
  if (n >= 1e6) return `${Math.round(n / 1e6)} МБ`
  return `${Math.max(1, Math.round(n / 1e3))} КБ`
}

export const PRESET_LABEL = { low: 'Низкое', normal: 'Обычное', high: 'Высокое', custom: 'Своё' } as const

export function qualityLabel(o: BuildOptions): string {
  return `${o.encoder === 'he-aac' ? 'HE-AAC' : 'AAC'} ${o.bitrate} кбит/с · ${channelsLabel(o.channels)} · ${khz(o.sampleRate)}`
}

export function partsLabel(o: BuildOptions): string {
  const h = `${o.partHours.toLocaleString('ru')} ч`
  switch (o.partsMode) {
    case 'none':
      return 'одним файлом'
    case 'chapters':
      return `части по ~${h} (по главам)`
    case 'files':
      return `части по ~${h} (по файлам)`
    case 'exact':
      return `части ровно по ${h}`
    case 'perChapter':
      return 'файл на каждую главу'
  }
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}
