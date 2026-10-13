// Contract between the main process and the UI (exposed via preload as window.api).

import type { BuildOptions, BuildProgress, BuildResult, Chapter, Project, SourceFile, BookMeta } from '../core/types.ts'
import type { ProbeChapter, TitleSource } from '../core/probe.ts'

export interface Settings {
  titleSource: TitleSource // chapter/file names from tags or from file names
  chapterPerFile: boolean // new files each start a chapter
  outputMode: 'ask' | 'fixed'
  outputDir: string
  defaults: BuildOptions
  recent: { authors: string[]; narrators: string[]; genres: string[]; projects: string[] }
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  appleAac: boolean
  ffmpeg: string // version string, '' when ffmpeg is missing
  ffmpegError?: string
}

export interface ProbeResponse {
  results: { file: SourceFile; chapters: ProbeChapter[] }[]
  errors: string[]
}

export interface ImportResponse {
  meta: BookMeta
  file: SourceFile
  chapters: Chapter[]
  warnings: string[]
}

export interface OpenProjectResponse {
  project: Project
  path: string
  missing: string[]
}

export type MenuCommand =
  | 'new' | 'open' | 'import' | 'save' | 'saveAs' | 'addFiles' | 'addFolder'
  | 'build' | 'buildOptions' | 'settings' | 'undo' | 'redo' | 'selectAll'
  | 'playPause' | 'markChapter'

export interface Api {
  info(): Promise<AppInfo>
  pathForFile(file: File): string
  mediaUrl(path: string): string

  pickAudio(): Promise<string[]>
  pickFolder(): Promise<string[]>
  expand(paths: string[]): Promise<string[]>
  probe(paths: string[], titleSource: TitleSource): Promise<ProbeResponse>
  onProbeProgress(cb: (done: number, total: number) => void): () => void
  importBook(path?: string): Promise<ImportResponse | undefined>

  pickImage(): Promise<string | undefined>
  extractCover(audioPath: string): Promise<string | undefined>
  pasteImage(): Promise<string | undefined>

  openProject(path?: string): Promise<OpenProjectResponse | undefined>
  saveProject(project: Project, path: string | undefined, saveAs: boolean): Promise<string | undefined>

  build(project: Project): Promise<BuildResult | undefined>
  cancelBuild(): Promise<void>
  onBuildProgress(cb: (p: BuildProgress) => void): () => void

  reveal(path: string): Promise<void>
  openPath(path: string): Promise<void>
  saveText(defaultName: string, text: string): Promise<void>
  confirm(message: string, detail: string, buttons: string[]): Promise<number>

  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickOutputDir(): Promise<string | undefined>

  onMenu(cb: (cmd: MenuCommand) => void): () => void
  onOpenFile(cb: (path: string) => void): () => void
  setDocumentState(state: { dirty: boolean; title: string; path?: string }): void
}
