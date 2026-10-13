// Packs dist/mac-arm64/Audiobinder.app into a drag-to-Applications DMG.
// electron-builder's dmgbuild fails on macOS 27 ("Resource busy" on detach while
// the system scans the bundled binaries), so we use `diskutil image create from`,
// falling back to hdiutil on systems that don't have it.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const { version, productName } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const app = join(root, 'dist/mac-arm64', `${productName}.app`)
const out = join(root, 'dist', `${productName}-${version}-mac-arm64.dmg`)
const volume = `${productName} ${version}`

const stage = join(mkdtempSync(join(tmpdir(), 'dmg-')), productName)
try {
  execFileSync('ditto', [app, join(stage, `${productName}.app`)])
  symlinkSync('/Applications', join(stage, 'Applications'))
  rmSync(out, { force: true })
  try {
    execFileSync('diskutil', ['image', 'create', 'from', '--format', 'ULMO', '--volumeName', volume, stage, out], { stdio: 'ignore' })
  } catch {
    execFileSync('hdiutil', ['create', '-volname', volume, '-srcfolder', stage, '-ov', '-format', 'ULMO', out], { stdio: 'inherit' })
  }
  console.log(out)
} finally {
  rmSync(join(stage, '..'), { recursive: true, force: true })
}
