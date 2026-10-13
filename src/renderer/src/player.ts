// Preview playback across the project's files on one book timeline.

import { create } from 'zustand'
import { fileStarts, locate } from '../../core/chapters.ts'
import { useStore } from './store.ts'

interface PlayerState {
  playing: boolean
  time: number // book time, seconds
}

export const usePlayer = create<PlayerState>(() => ({ playing: false, time: 0 }))

const audio = new Audio()
audio.preload = 'auto'
let currentFileId: string | undefined
let pendingSeek: number | undefined

function files() {
  return useStore.getState().project.files
}

function startOf(fileId: string): number {
  return fileStarts(files()).get(fileId) ?? 0
}

function load(fileId: string, offset: number): void {
  const f = files().find((x) => x.id === fileId)
  if (!f) return
  currentFileId = fileId
  pendingSeek = offset
  audio.src = window.api.mediaUrl(f.path)
}

audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek !== undefined) {
    audio.currentTime = pendingSeek
    pendingSeek = undefined
  }
  if (usePlayer.getState().playing) audio.play().catch(() => {})
})

audio.addEventListener('timeupdate', () => {
  if (!currentFileId || pendingSeek !== undefined) return
  usePlayer.setState({ time: startOf(currentFileId) + audio.currentTime })
})

audio.addEventListener('ended', () => {
  const list = files()
  const i = list.findIndex((f) => f.id === currentFileId)
  if (i >= 0 && i + 1 < list.length) load(list[i + 1].id, 0)
  else usePlayer.setState({ playing: false })
})

audio.addEventListener('error', () => {
  const f = files().find((x) => x.id === currentFileId)
  usePlayer.setState({ playing: false })
  currentFileId = undefined
  if (f) useStore.getState().toast('info', 'Этот файл нельзя прослушать в предпросмотре', `${f.name} — сборка при этом работает`)
})

export function seek(t: number): void {
  const list = files()
  const total = list.reduce((a, f) => a + f.duration, 0)
  const clamped = Math.max(0, Math.min(t, Math.max(0, total - 0.05)))
  usePlayer.setState({ time: clamped })
  const loc = locate(list, clamped)
  if (!loc) return
  if (loc.fileId === currentFileId && pendingSeek === undefined) audio.currentTime = loc.offset
  else load(loc.fileId, loc.offset)
}

export function play(): void {
  if (!files().length) return
  usePlayer.setState({ playing: true })
  if (!currentFileId || !files().some((f) => f.id === currentFileId)) seek(usePlayer.getState().time)
  else audio.play().catch(() => {})
}

export function pause(): void {
  usePlayer.setState({ playing: false })
  audio.pause()
}

export function toggle(): void {
  if (usePlayer.getState().playing) pause()
  else play()
}

export function skip(delta: number): void {
  seek(usePlayer.getState().time + delta)
}

export function playFrom(t: number): void {
  seek(t)
  play()
}

/** Keeps playback consistent when files are reordered or removed. */
useStore.subscribe((s, prev) => {
  if (s.project.files === prev.project.files) return
  if (currentFileId && !s.project.files.some((f) => f.id === currentFileId)) {
    pause()
    audio.removeAttribute('src')
    currentFileId = undefined
    usePlayer.setState({ time: 0 })
  } else if (currentFileId) {
    usePlayer.setState({ time: startOf(currentFileId) + audio.currentTime })
  }
})
