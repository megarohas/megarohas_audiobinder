import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api } from '../shared/api.ts'

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const h = (_e: unknown, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api: Api = {
  info: () => ipcRenderer.invoke('info'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,

  pickAudio: () => ipcRenderer.invoke('pickAudio'),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  expand: (paths) => ipcRenderer.invoke('expand', paths),
  probe: (paths, titleSource) => ipcRenderer.invoke('probe', paths, titleSource),
  onProbeProgress: (cb) => listen('probe-progress', cb),
  importBook: (path) => ipcRenderer.invoke('importBook', path),

  pickImage: () => ipcRenderer.invoke('pickImage'),
  extractCover: (p) => ipcRenderer.invoke('extractCover', p),
  pasteImage: () => ipcRenderer.invoke('pasteImage'),

  openProject: (path) => ipcRenderer.invoke('openProject', path),
  saveProject: (project, path, saveAs) => ipcRenderer.invoke('saveProject', project, path, saveAs),

  build: (project) => ipcRenderer.invoke('build', project),
  cancelBuild: () => ipcRenderer.invoke('cancelBuild'),
  onBuildProgress: (cb) => listen('build-progress', cb),

  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  saveText: (name, text) => ipcRenderer.invoke('saveText', name, text),
  confirm: (message, detail, buttons) => ipcRenderer.invoke('confirm', message, detail, buttons),

  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  pickOutputDir: () => ipcRenderer.invoke('pickOutputDir'),

  onMenu: (cb) => listen('menu', cb),
  onOpenFile: (cb) => listen('open-file', cb),
  setDocumentState: (s) => ipcRenderer.send('document-state', s),
}

contextBridge.exposeInMainWorld('api', api)
