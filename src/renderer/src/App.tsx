import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, AudioLines, BookOpen, CheckCircle2, FileAudio, FolderOpen, FolderPlus, Info, Loader2, Save, Settings, X } from 'lucide-react'
import { timeline } from '../../core/chapters.ts'
import { addPaths, importBook, markChapterAtPlayer, newProject, openProject, pickAndAdd, removeSelection, saveProject, selectAll, startBuild } from './actions.ts'
import { BookPanel } from './components/BookPanel.tsx'
import { BuildBar, BuildOverlay } from './components/BuildBar.tsx'
import { ChaptersToolbar, ChaptersView } from './components/ChaptersView.tsx'
import { BuildOptionsDialog, ChapterListDialog, RenameDialog, SettingsDialog } from './components/Dialogs.tsx'
import { FilesToolbar, FilesView } from './components/FilesView.tsx'
import { PlayerBar } from './components/PlayerBar.tsx'
import { droppedPaths, isEditable, isImagePath } from './hooks.ts'
import { toggle } from './player.ts'
import { newProjectFromSettings, useStore } from './store.ts'

function TopBar() {
  const title = useStore((s) => s.project.meta.title)
  const dirty = useStore((s) => s.dirty)
  const hasFiles = useStore((s) => s.project.files.length > 0)
  const path = useStore((s) => s.path)
  const mac = useStore((s) => s.info?.platform === 'darwin')
  const set = useStore((s) => s.set)
  return (
    <div className={`topbar ${mac ? 'mac' : ''}`}>
      <div className="brand">
        <div className="logo">
          <AudioLines size={14} />
        </div>
        Audiobinder
      </div>
      <div className="doc">
        {title || (hasFiles ? 'Без названия' : '')}
        {path && <span className="sub"> · {path.split(/[\\/]/).pop()}</span>}
        {dirty && hasFiles && <span className="dot" title="Есть несохранённые изменения" />}
      </div>
      <div className="spacer" />
      <button className="btn ghost" onClick={() => openProject()} title="Открыть проект (⌘O)">
        <FolderOpen size={15} /> Открыть
      </button>
      <button className="btn ghost" disabled={!hasFiles} onClick={() => saveProject(false)} title="Сохранить проект (⌘S)">
        <Save size={15} /> Сохранить
      </button>
      <button className="icon-btn" onClick={() => set({ dialog: 'settings' })} title="Настройки">
        <Settings size={16} />
      </button>
    </div>
  )
}

const NO_RECENT: string[] = []

function Empty() {
  const recent = useStore((s) => s.settings?.recent.projects ?? NO_RECENT)
  return (
    <div className="empty">
      <div className="drop-card">
        <div className="big-icon">
          <FileAudio size={30} />
        </div>
        <h2>Перетащите сюда аудиофайлы или папку</h2>
        <p>MP3, M4A, M4B, FLAC, WAV, OGG, AAC и другие — в любом количестве и любой длины</p>
        <div className="actions">
          <button className="btn primary" onClick={() => pickAndAdd('files')}>
            <FileAudio size={15} /> Выбрать файлы
          </button>
          <button className="btn" onClick={() => pickAndAdd('folder')}>
            <FolderPlus size={15} /> Папку
          </button>
          <button className="btn" onClick={() => importBook()}>
            <BookOpen size={15} /> Править готовую M4B
          </button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <h4>Недавние проекты</h4>
            {recent.slice(0, 6).map((p) => (
              <button key={p} onClick={() => openProject(p)}>
                <FolderOpen size={14} style={{ flex: 'none', color: 'var(--faint)' }} />
                <span>{p.split(/[\\/]/).pop()?.replace(/\.abproj$/, '')}</span>
                <span className="path">{p}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismiss)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <AlertCircle className="k" size={18} /> : t.kind === 'success' ? <CheckCircle2 className="k" size={18} /> : <Info className="k" size={18} />}
          <div>
            <div className="t">{t.text}</div>
            {t.detail && <div className="d">{t.detail}</div>}
          </div>
          <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Busy() {
  const busy = useStore((s) => s.busy)
  if (!busy) return null
  return (
    <div className="busy">
      <Loader2 size={15} className="spin" />
      {busy.label}
      {busy.total > 1 && (
        <span className="sub">
          {busy.done} из {busy.total}
        </span>
      )}
    </div>
  )
}

export function App() {
  const s = useStore()
  const { project, tab, dialog, set } = s
  const [dragging, setDragging] = useState(false)
  const chapterCount = useMemo(() => timeline(project).length, [project])
  const hasFiles = project.files.length > 0

  // Startup: settings, ffmpeg info, fresh project with default options.
  useEffect(() => {
    Promise.all([window.api.getSettings(), window.api.info()]).then(([settings, info]) => {
      useStore.setState({ settings, info })
      if (!useStore.getState().project.files.length) useStore.getState().load(newProjectFromSettings(settings))
      if (!info.ffmpeg) useStore.getState().toast('error', 'Не найден ffmpeg — сборка невозможна', info.ffmpegError)
    })
  }, [])

  // Window title / edited dot.
  useEffect(() => {
    window.api.setDocumentState({ dirty: s.dirty && hasFiles, title: project.meta.title, path: s.path })
  }, [s.dirty, hasFiles, project.meta.title, s.path])

  // Menu commands and files opened from the OS.
  useEffect(() => {
    const offMenu = window.api.onMenu((cmd) => {
      const st = useStore.getState()
      const editing = isEditable(document.activeElement)
      switch (cmd) {
        case 'new': return void newProject()
        case 'open': return void openProject()
        case 'import': return void importBook()
        case 'save': return void saveProject(false)
        case 'saveAs': return void saveProject(true)
        case 'addFiles': return void pickAndAdd('files')
        case 'addFolder': return void pickAndAdd('folder')
        case 'build': return void startBuild()
        case 'buildOptions': return st.set({ dialog: 'buildOptions' })
        case 'settings': return st.set({ dialog: 'settings' })
        case 'undo': return editing ? void document.execCommand('undo') : st.undo()
        case 'redo': return editing ? void document.execCommand('redo') : st.redo()
        case 'selectAll': return editing ? void document.execCommand('selectAll') : selectAll()
        case 'playPause': return toggle()
        case 'markChapter': return markChapterAtPlayer()
      }
    })
    const offOpen = window.api.onOpenFile((p) => (p.toLowerCase().endsWith('.m4b') ? importBook(p) : openProject(p)))
    return () => {
      offMenu()
      offOpen()
    }
  }, [])

  // Keyboard: space plays, Delete removes the selection.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isEditable(document.activeElement) || useStore.getState().dialog) return
      if (e.key === ' ') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeSelection()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // Whole-window drop: audio and folders are added, images become the cover.
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const paths = droppedPaths(e)
    const images = paths.filter(isImagePath)
    const rest = paths.filter((p) => !isImagePath(p))
    if (images.length && !rest.length) {
      useStore.getState().setMeta({ cover: images[0] })
      return
    }
    if (rest.length) addPaths(rest)
  }

  return (
    <div className="app" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <TopBar />
      <div className="body">
        <BookPanel />
        <main className="main">
          <div className="tabs-bar">
            <div className="segmented">
              <button className={tab === 'chapters' ? 'on' : ''} onClick={() => set({ tab: 'chapters' })}>
                Главы <span className="count">{chapterCount}</span>
              </button>
              <button className={tab === 'files' ? 'on' : ''} onClick={() => set({ tab: 'files' })}>
                Файлы <span className="count">{project.files.length}</span>
              </button>
            </div>
            {hasFiles && (tab === 'chapters' ? <ChaptersToolbar /> : <FilesToolbar />)}
          </div>
          {!hasFiles ? <Empty /> : tab === 'chapters' ? <ChaptersView /> : <FilesView />}
        </main>
      </div>
      <PlayerBar />
      <BuildBar />

      {dialog === 'rename' && <RenameDialog />}
      {dialog === 'list' && <ChapterListDialog />}
      {dialog === 'buildOptions' && <BuildOptionsDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      <BuildOverlay />
      <Busy />
      <Toasts />
      {dragging && (
        <div className="drop-overlay">
          <div>Отпустите, чтобы добавить</div>
        </div>
      )}
    </div>
  )
}
