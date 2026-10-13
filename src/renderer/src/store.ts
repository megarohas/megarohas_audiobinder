import { create } from 'zustand'
import { defaultBuildOptions, emptyProject, type BookMeta, type BuildProgress, type BuildResult, type Project } from '../../core/types.ts'
import type { AppInfo, Settings } from '../../shared/api.ts'

export type Tab = 'chapters' | 'files'
export type DialogKind = 'rename' | 'list' | 'buildOptions' | 'settings' | null

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
  detail?: string
}

export interface BuildState {
  running: boolean
  progress?: BuildProgress
  result?: BuildResult
  error?: string
}

interface Store {
  project: Project
  path?: string
  dirty: boolean
  past: Project[]
  future: Project[]
  coalesce?: { key: string; at: number }
  tab: Tab
  selChapters: string[]
  selFiles: string[]
  settings: Settings | null
  info: AppInfo | null
  busy: { label: string; done: number; total: number } | null
  build: BuildState
  dialog: DialogKind
  toasts: Toast[]
  missing: string[]
  editChapter?: string // chapter id whose title should grab focus

  commit(fn: (p: Project) => Project, coalesceKey?: string): void
  setMeta(patch: Partial<BookMeta>, key?: string): void
  undo(): void
  redo(): void
  load(project: Project, path?: string, missing?: string[]): void
  markSaved(path: string): void
  set(patch: Partial<Store>): void
  toast(kind: Toast['kind'], text: string, detail?: string): void
  dismiss(id: number): void
}

const HISTORY = 200
let toastId = 0

export const useStore = create<Store>((set, get) => ({
  project: emptyProject(),
  dirty: false,
  past: [],
  future: [],
  tab: 'chapters',
  selChapters: [],
  selFiles: [],
  settings: null,
  info: null,
  busy: null,
  build: { running: false },
  dialog: null,
  toasts: [],
  missing: [],

  commit(fn, coalesceKey) {
    const { project, past, coalesce } = get()
    const next = fn(project)
    if (next === project) return
    const now = Date.now()
    const merge = coalesceKey && coalesce?.key === coalesceKey && now - coalesce.at < 1500
    set({
      project: next,
      past: merge ? past : [...past.slice(-HISTORY + 1), project],
      future: [],
      dirty: true,
      coalesce: coalesceKey ? { key: coalesceKey, at: now } : undefined,
    })
  },

  setMeta(patch, key) {
    get().commit((p) => ({ ...p, meta: { ...p.meta, ...patch } }), key)
  },

  undo() {
    const { past, project, future } = get()
    if (!past.length) return
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], dirty: true, coalesce: undefined })
  },

  redo() {
    const { past, project, future } = get()
    if (!future.length) return
    set({ project: future[0], future: future.slice(1), past: [...past, project], dirty: true, coalesce: undefined })
  },

  load(project, path, missing = []) {
    set({ project, path, missing, dirty: false, past: [], future: [], coalesce: undefined, selChapters: [], selFiles: [], build: { running: false } })
  },

  markSaved(path) {
    set({ path, dirty: false })
  },

  set(patch) {
    set(patch)
  },

  toast(kind, text, detail) {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, kind, text, detail }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 12000 : 5000)
  },

  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
}))

export function newProjectFromSettings(s: Settings | null): Project {
  return emptyProject({ ...defaultBuildOptions(), ...(s?.defaults ?? {}) })
}
