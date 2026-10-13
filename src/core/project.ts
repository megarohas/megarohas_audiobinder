// Project files: a small JSON document that references the source audio.

import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { defaultBuildOptions, emptyMeta, type Project } from './types.ts'

export const PROJECT_EXT = 'abproj'

interface Stored {
  app: 'audiobinder'
  version: 1
  project: Project
  relative: Record<string, string> // absolute path → path relative to the project file
}

function allPaths(p: Project): string[] {
  return [
    ...p.files.map((f) => f.path),
    ...p.chapters.map((c) => c.image).filter((x): x is string => !!x),
    ...(p.meta.cover ? [p.meta.cover] : []),
  ]
}

export async function saveProject(p: Project, file: string): Promise<void> {
  const base = dirname(file)
  const rel: Record<string, string> = {}
  for (const a of allPaths(p)) rel[a] = relative(base, a)
  const stored: Stored = { app: 'audiobinder', version: 1, project: p, relative: rel }
  await writeFile(file, JSON.stringify(stored, null, 2), 'utf8')
}

async function exists(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => undefined))
}

/** Loads a project; paths that moved together with the project file are re-resolved. */
export async function loadProject(file: string): Promise<{ project: Project; missing: string[] }> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Stored
  if (raw.app !== 'audiobinder' || !raw.project) throw new Error('Это не файл проекта Audiobinder')
  const base = dirname(file)
  const fix = async (a: string): Promise<string> => {
    if (await exists(a)) return a
    const r = raw.relative?.[a]
    if (r && !isAbsolute(r)) {
      const cand = resolve(base, r)
      if (await exists(cand)) return cand
    }
    return a
  }
  const p = raw.project
  const project: Project = {
    version: 1,
    meta: { ...emptyMeta(), ...p.meta },
    files: [],
    chapters: [],
    build: { ...defaultBuildOptions(), ...p.build },
  }
  for (const f of p.files) project.files.push({ ...f, path: await fix(f.path) })
  for (const c of p.chapters) project.chapters.push({ ...c, ...(c.image ? { image: await fix(c.image) } : {}) })
  if (p.meta.cover) project.meta.cover = await fix(p.meta.cover)
  const missing: string[] = []
  for (const a of allPaths(project)) if (!(await exists(a))) missing.push(a)
  return { project, missing }
}
