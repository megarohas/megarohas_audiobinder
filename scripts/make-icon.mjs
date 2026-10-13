// Renders resources/icon.svg to resources/icon.png (1024×1024, transparent)
// with an offscreen Electron window:  npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const svg = readFileSync(join(root, 'resources/icon.svg'), 'utf8')
const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`

app.dock?.hide()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  })
  let frame
  win.webContents.on('paint', (_e, _d, image) => (frame = image))
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 800))
  win.webContents.invalidate()
  await new Promise((r) => setTimeout(r, 500))
  const png = frame.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()
  writeFileSync(join(root, 'resources/icon.png'), png)
  console.log('resources/icon.png', frame.getSize())
  app.exit(0)
})
