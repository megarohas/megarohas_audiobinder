import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol, shell, type MenuItemConstructorOptions } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { buildBook, plannedOutputs } from '../core/build.ts'
import { capabilities, runTool, setTools } from '../core/ffmpeg.ts'
import { importBook } from '../core/importer.ts'
import { AUDIO_EXTENSIONS, expandPaths, probeMany } from '../core/probe.ts'
import { loadProject, PROJECT_EXT, saveProject } from '../core/project.ts'
import { defaultBuildOptions, type Project } from '../core/types.ts'
import type { AppInfo, MenuCommand, Settings } from '../shared/api.ts'
import { runSmoke, smokeConfig } from './smoke.ts'

app.setName('Audiobinder')
const isMac = process.platform === 'darwin'
const cacheDir = () => join(app.getPath('userData'), 'cache')
const smoke = smokeConfig()
if (smoke) app.setPath('userData', join(smoke.out, 'userData'))

// ------------------------------------------------------------ ffmpeg

function locateTools(): void {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const candidates = [
    join(process.resourcesPath ?? '', 'ffmpeg'),
    join(app.getAppPath(), 'vendor', 'ffmpeg', `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, `ffmpeg${exe}`)) && existsSync(join(dir, `ffprobe${exe}`))) {
      setTools({ ffmpeg: join(dir, `ffmpeg${exe}`), ffprobe: join(dir, `ffprobe${exe}`) })
      return
    }
  }
  // Development fallback: GUI apps on macOS don't inherit the shell PATH.
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (existsSync(join(dir, 'ffmpeg')) && existsSync(join(dir, 'ffprobe'))) {
      setTools({ ffmpeg: join(dir, 'ffmpeg'), ffprobe: join(dir, 'ffprobe') })
      return
    }
  }
  setTools({ ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}` })
}

// ------------------------------------------------------------ settings

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

function defaultSettings(): Settings {
  return {
    titleSource: 'tag',
    chapterPerFile: true,
    outputMode: 'ask',
    outputDir: app.getPath('music'),
    defaults: defaultBuildOptions(),
    recent: { authors: [], narrators: [], genres: [], projects: [] },
  }
}

let settings: Settings = defaultSettings()

async function loadSettings(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(settingsFile(), 'utf8'))
    const d = defaultSettings()
    settings = { ...d, ...raw, defaults: { ...d.defaults, ...raw.defaults }, recent: { ...d.recent, ...raw.recent } }
  } catch {
    settings = defaultSettings()
  }
}

async function saveSettings(): Promise<void> {
  await mkdir(dirname(settingsFile()), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8')
}

function remember(list: string[], value: string, max = 30): string[] {
  const v = value.trim()
  if (!v) return list
  return [v, ...list.filter((x) => x !== v)].slice(0, max)
}

async function rememberProject(p: Project, path?: string): Promise<void> {
  const r = settings.recent
  settings.recent = {
    authors: remember(r.authors, p.meta.author),
    narrators: remember(r.narrators, p.meta.narrator),
    genres: remember(r.genres, p.meta.genre),
    projects: path ? remember(r.projects, path, 12) : r.projects,
  }
  if (path) app.addRecentDocument(path)
  await saveSettings()
  buildMenu()
}

// ------------------------------------------------------------ media protocol

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
])

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.webm': 'audio/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
}

function registerMediaProtocol(): void {
  protocol.handle('media', async (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1))
    const ext = extname(file).toLowerCase()
    if (!MIME[ext] && !AUDIO_EXTENSIONS.has(ext)) return new Response('forbidden', { status: 403 })
    const st = await stat(file).catch(() => undefined)
    if (!st?.isFile()) return new Response('not found', { status: 404 })
    const type = MIME[ext] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
      return new Response(body, {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' },
      })
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream
    return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' } })
  })
}

// ------------------------------------------------------------ window

let win: BrowserWindow | undefined
let docState = { dirty: false, title: '', path: undefined as string | undefined }
let pendingOpen: string | undefined

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'Audiobinder',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17171a' : '#f6f6f8',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      offscreen: !!smoke,
    },
  })
  if (!smoke) win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => {
    if (!docState.dirty || !win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Закрыть без сохранения', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      message: 'Есть несохранённые изменения',
      detail: 'Если закрыть окно сейчас, изменения в проекте пропадут.',
    })
    if (choice === 1) e.preventDefault()
  })
  win.on('closed', () => (win = undefined))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  const query = smoke ? { smoke: '1' } : undefined
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + (smoke ? '?smoke=1' : ''))
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { query })
  win.webContents.once('did-finish-load', () => {
    if (smoke) void runSmoke(win!, smoke)
    if (pendingOpen) {
      win?.webContents.send('open-file', pendingOpen)
      pendingOpen = undefined
    }
  })
}

function send(cmd: MenuCommand): void {
  win?.webContents.send('menu', cmd)
}

function buildMenu(): void {
  const recent: MenuItemConstructorOptions[] = settings.recent.projects.length
    ? settings.recent.projects.map((p) => ({ label: basename(p), click: () => win?.webContents.send('open-file', p) }))
    : [{ label: 'Пусто', enabled: false }]
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: 'Audiobinder',
          submenu: [
            { role: 'about', label: 'О программе Audiobinder' },
            { type: 'separator' },
            { label: 'Настройки…', accelerator: 'Cmd+,', click: () => send('settings') },
            { type: 'separator' },
            { role: 'hide', label: 'Скрыть Audiobinder' },
            { role: 'hideOthers', label: 'Скрыть остальные' },
            { role: 'unhide', label: 'Показать все' },
            { type: 'separator' },
            { role: 'quit', label: 'Завершить Audiobinder' },
          ],
        } as MenuItemConstructorOptions]
      : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая книга', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Открыть проект…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Открыть недавние', submenu: recent },
        { label: 'Редактировать готовую книгу (M4B)…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('import') },
        { type: 'separator' },
        { label: 'Добавить аудиофайлы…', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('addFiles') },
        { label: 'Добавить папку…', click: () => send('addFolder') },
        { type: 'separator' },
        { label: 'Сохранить проект', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Сохранить проект как…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        { type: 'separator' },
        { label: 'Параметры сборки…', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('buildOptions') },
        { label: 'Собрать аудиокнигу', accelerator: 'CmdOrCtrl+B', click: () => send('build') },
        ...(!isMac
          ? [{ type: 'separator' }, { label: 'Настройки…', accelerator: 'Ctrl+,', click: () => send('settings') }, { type: 'separator' }, { role: 'quit', label: 'Выход' }] as MenuItemConstructorOptions[]
          : [{ type: 'separator' }, { role: 'close', label: 'Закрыть окно' }] as MenuItemConstructorOptions[]),
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Повторить', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { label: 'Выбрать все', accelerator: 'CmdOrCtrl+A', click: () => send('selectAll') },
      ],
    },
    {
      label: 'Воспроизведение',
      submenu: [
        { label: 'Пуск / пауза', accelerator: 'CmdOrCtrl+P', click: () => send('playPause') },
        { label: 'Новая глава в позиции плеера', accelerator: 'CmdOrCtrl+M', click: () => send('markChapter') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'resetZoom', label: 'Обычный размер' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
      ],
    },
    { role: 'windowMenu', label: 'Окно' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ------------------------------------------------------------ IPC

const AUDIO_FILTER = { name: 'Аудио', extensions: [...AUDIO_EXTENSIONS].map((e) => e.slice(1)) }
const IMAGE_FILTER = { name: 'Картинки', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'tif', 'tiff'] }
let buildAbort: AbortController | undefined

function registerIpc(): void {
  ipcMain.handle('info', async (): Promise<AppInfo> => {
    try {
      const c = await capabilities()
      return { version: app.getVersion(), platform: process.platform, appleAac: c.appleAac, ffmpeg: c.version }
    } catch (e) {
      return { version: app.getVersion(), platform: process.platform, appleAac: false, ffmpeg: '', ffmpegError: (e as Error).message }
    }
  })

  ipcMain.handle('pickAudio', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Добавить аудиофайлы', properties: ['openFile', 'multiSelections'], filters: [AUDIO_FILTER] })
    return r.canceled ? [] : expandPaths(r.filePaths)
  })
  ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Добавить папку', properties: ['openDirectory', 'multiSelections'] })
    return r.canceled ? [] : expandPaths(r.filePaths)
  })
  ipcMain.handle('expand', (_e, paths: string[]) => expandPaths(paths))
  ipcMain.handle('probe', (e, paths: string[], titleSource) =>
    probeMany(paths, titleSource, (done, total) => e.sender.send('probe-progress', done, total)),
  )
  ipcMain.handle('importBook', async (_e, path?: string) => {
    if (!path) {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Открыть готовую аудиокнигу',
        properties: ['openFile'],
        filters: [{ name: 'Аудиокниги', extensions: ['m4b', 'm4a', 'mp4', 'mp3'] }],
      })
      if (r.canceled) return undefined
      path = r.filePaths[0]
    }
    return importBook(path, cacheDir())
  })

  ipcMain.handle('pickImage', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Выбрать картинку', properties: ['openFile'], filters: [IMAGE_FILTER] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('extractCover', async (_e, audioPath: string) => {
    await mkdir(cacheDir(), { recursive: true })
    const out = join(cacheDir(), `${crypto.randomUUID()}.jpg`)
    return runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-i', audioPath, '-map', '0:v:0', '-frames:v', '1', '-y', out])
      .then(() => out)
      .catch(() => undefined)
  })
  ipcMain.handle('pasteImage', async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => /^image\/(png|jpeg|webp|gif|bmp|tiff)$/.test(t))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      await mkdir(cacheDir(), { recursive: true })
      const p = join(cacheDir(), `${crypto.randomUUID()}.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}`)
      await writeFile(p, Buffer.from(await blob.arrayBuffer()))
      return p
    }
    return undefined
  })

  ipcMain.handle('openProject', async (_e, path?: string) => {
    if (!path) {
      const r = await dialog.showOpenDialog(win!, { title: 'Открыть проект', properties: ['openFile'], filters: [{ name: 'Проект Audiobinder', extensions: [PROJECT_EXT] }] })
      if (r.canceled) return undefined
      path = r.filePaths[0]
    }
    const { project, missing } = await loadProject(path)
    await rememberProject(project, path)
    return { project, path, missing }
  })
  ipcMain.handle('saveProject', async (_e, project: Project, path: string | undefined, saveAs: boolean) => {
    if (!path || saveAs) {
      const r = await dialog.showSaveDialog(win!, {
        title: 'Сохранить проект',
        defaultPath: join(path ? dirname(path) : app.getPath('documents'), `${project.meta.title.trim() || 'Аудиокнига'}.${PROJECT_EXT}`),
        filters: [{ name: 'Проект Audiobinder', extensions: [PROJECT_EXT] }],
      })
      if (r.canceled || !r.filePath) return undefined
      path = r.filePath
    }
    await saveProject(project, path)
    await rememberProject(project, path)
    return path
  })

  ipcMain.handle('build', async (e, project: Project) => {
    let outDir = settings.outputDir
    if (settings.outputMode === 'ask' || !existsSync(outDir)) {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Куда сохранить аудиокнигу',
        defaultPath: settings.outputDir,
        buttonLabel: 'Сохранить сюда',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled) return undefined
      outDir = r.filePaths[0]
      settings.outputDir = outDir
    }
    const existing = plannedOutputs(project, outDir).filter((f) => existsSync(f))
    if (existing.length) {
      const c = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: ['Заменить', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        message: existing.length === 1 ? `«${basename(existing[0])}» уже существует` : `${existing.length} файла уже существуют`,
        detail: 'Заменить их новой сборкой?',
      })
      if (c.response === 1) return undefined
    }
    await rememberProject(project)
    buildAbort = new AbortController()
    try {
      return await buildBook({
        project,
        outputDir: outDir,
        tool: `Audiobinder ${app.getVersion()}`,
        signal: buildAbort.signal,
        onProgress: (p) => {
          e.sender.send('build-progress', p)
          win?.setProgressBar(p.stage === 'done' ? -1 : p.fraction)
        },
      })
    } finally {
      buildAbort = undefined
      win?.setProgressBar(-1)
    }
  })
  ipcMain.handle('cancelBuild', () => buildAbort?.abort())

  ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('openPath', (_e, p: string) => shell.openPath(p).then(() => undefined))
  ipcMain.handle('saveText', async (_e, name: string, text: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Текст', extensions: ['txt'] }] })
    if (!r.canceled && r.filePath) await writeFile(r.filePath, text, 'utf8')
  })
  ipcMain.handle('confirm', async (_e, message: string, detail: string, buttons: string[]) => {
    const r = await dialog.showMessageBox(win!, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 })
    return r.response
  })

  ipcMain.handle('getSettings', () => settings)
  ipcMain.handle('setSettings', async (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    await saveSettings()
    return settings
  })
  ipcMain.handle('pickOutputDir', async () => {
    const r = await dialog.showOpenDialog(win!, { defaultPath: settings.outputDir, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })

  ipcMain.on('document-state', (_e, s: typeof docState) => {
    docState = s
    if (!win) return
    win.setTitle(s.title ? `${s.title} — Audiobinder` : 'Audiobinder')
    win.setDocumentEdited(s.dirty)
    if (s.path) win.setRepresentedFilename(s.path)
  })
}

// ------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) app.quit()

function fileArg(argv: string[]): string | undefined {
  return argv.find((a) => a.toLowerCase().endsWith(`.${PROJECT_EXT}`) || /\.(m4b)$/i.test(a))
}

app.on('second-instance', (_e, argv) => {
  const f = fileArg(argv)
  if (f) win?.webContents.send('open-file', f)
  if (win?.isMinimized()) win.restore()
  win?.focus()
})

app.on('open-file', (e, path) => {
  e.preventDefault()
  if (win && !win.webContents.isLoading()) win.webContents.send('open-file', path)
  else pendingOpen = path
})

app.whenReady().then(async () => {
  locateTools()
  await loadSettings()
  if (smoke) {
    app.dock?.hide()
    settings.outputMode = 'fixed'
    settings.outputDir = join(smoke.out, 'books')
    await mkdir(settings.outputDir, { recursive: true })
  }
  registerMediaProtocol()
  registerIpc()
  buildMenu()
  pendingOpen ??= fileArg(process.argv.slice(1))
  createWindow()
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow()
  })
})

app.on('window-all-closed', () => {
  buildAbort?.abort()
  if (!isMac) app.quit()
})
