// Headless end-to-end smoke run: drives the real UI in an offscreen window and
// saves screenshots. Enabled with AUDIOBINDER_SMOKE=<fixtures dir>; never shows a window.

import { app, nativeTheme, type BrowserWindow, type NativeImage } from 'electron'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function smokeConfig(): { fixtures: string; out: string } | undefined {
  const fixtures = process.env.AUDIOBINDER_SMOKE
  if (!fixtures) return undefined
  return { fixtures, out: process.env.AUDIOBINDER_SMOKE_OUT ?? join(fixtures, 'smoke-out') }
}

export async function runSmoke(win: BrowserWindow, cfg: { fixtures: string; out: string }): Promise<void> {
  const report: Record<string, unknown> = {}
  // Offscreen windows deliver frames through 'paint'; keep the latest one.
  let frame: NativeImage | undefined
  win.webContents.on('paint', (_e, _dirty, image) => (frame = image))
  win.webContents.setFrameRate(30)
  const consoleLog: string[] = []
  report.console = consoleLog
  win.webContents.on('console-message', (e) => consoleLog.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`))
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>
  const st = (expr: string) => js(`(() => { const s = window.__ab.store.getState(); return ${expr} })()`)
  const waitFor = async (expr: string, ms = 60000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if (await st(expr)) return
      await sleep(150)
    }
    throw new Error(`timeout: ${expr}`)
  }
  const shot = async (name: string) => {
    // Wait for React to commit, then for a fresh frame painted after that.
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await sleep(400)
    frame = undefined
    win.webContents.invalidate()
    const t = Date.now()
    while (!frame && Date.now() - t < 3000) await sleep(50)
    if (frame) await writeFile(join(cfg.out, `${name}.png`), (frame as NativeImage).toPNG())
  }

  try {
    await mkdir(cfg.out, { recursive: true })
    await waitFor('!!s.info')
    report.rootHtml = await js<string>('document.getElementById("root").innerHTML.length')
    await shot('01-empty')

    const files = (await readdir(cfg.fixtures)).filter((f) => /\.(mp3|m4a|flac|wav|ogg)$/i.test(f)).map((f) => join(cfg.fixtures, f))
    await js(`window.__ab.actions.addPaths(${JSON.stringify(files)})`)
    await waitFor('s.project.files.length > 0 && !s.busy')
    await st(`s.setMeta({ title: 'Ведьмак. Последнее желание', author: 'Анджей Сапковский', narrator: 'Всеволод Кузнецов', genre: 'Фэнтези', year: '1993', description: 'Сборник рассказов о ведьмаке Геральте из Ривии.', cover: ${JSON.stringify(join(cfg.fixtures, 'cover.jpg'))} })`)
    await st(`(s.project.chapters.length && s.commit(p => ({ ...p, chapters: p.chapters.map((c, i) => i === 0 ? { ...c, image: ${JSON.stringify(join(cfg.fixtures, 'chapter.png'))} } : c) })), true)`)
    await shot('02-chapters')

    await st(`s.set({ tab: 'files', selFiles: [s.project.files[1].id] })`)
    await shot('03-files')
    await st(`s.set({ tab: 'chapters', selChapters: [] })`)

    for (const d of ['rename', 'list', 'buildOptions', 'settings']) {
      await st(`s.set({ dialog: '${d}' })`)
      await shot(`04-dialog-${d}`)
    }
    await st(`s.set({ dialog: null })`)

    // Timecode list replaces chapters.
    await js(`(() => {
      const { applyChapterList, parseChapterList } = window.__ab.chapters
      const s = window.__ab.store.getState()
      const r = applyChapterList(s.project, parseChapterList('0:00 Пролог\\n0:05 Ведьмак\\n0:11 Голос рассудка\\n0:15 Крупица истины'))
      s.commit(p => ({ ...p, chapters: r.chapters }))
    })()`)
    await js('window.__ab.player.seek(8)')
    await shot('05-chapters-from-list')

    nativeTheme.themeSource = 'dark'
    await shot('06-dark')
    nativeTheme.themeSource = 'system'

    await js('window.__ab.actions.startBuild()')
    await sleep(300)
    await shot('07-building')
    await waitFor('!s.build.running', 180000)
    report.build = await st('s.build')
    await shot('08-done')
  } catch (e) {
    report.error = (e as Error).stack
  }
  await writeFile(join(cfg.out, 'report.json'), JSON.stringify(report, null, 2))
  app.exit(0)
}
