// Downloads static ffmpeg/ffprobe builds into vendor/ffmpeg/<os>-<arch>, verifying SHA-256.
//   node scripts/fetch-ffmpeg.mjs [mac-arm64] [win-x64]
// Sources are the builds linked from ffmpeg.org/download.html:
//   macOS — Martin Riedl (signed & notarized, includes Apple AudioToolbox AAC/HE-AAC)
//   Windows — BtbN FFmpeg-Builds (LGPL, shared DLLs)

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const RIEDL = 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2'
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
const WIN_ZIP = 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip'

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function expectSum(buf, sums, name) {
  const line = sums.split('\n').find((l) => l.trim().endsWith(name) || /^[0-9a-f]{64}\s*$/.test(l.trim()))
  const want = line?.trim().split(/\s+/)[0]
  if (!want) throw new Error(`нет контрольной суммы для ${name}`)
  if (sha256(buf) !== want) throw new Error(`контрольная сумма не совпала: ${name}`)
}

function unzip(buf, name) {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-'))
  const zip = join(dir, name)
  writeFileSync(zip, buf)
  execFileSync('tar', ['-xf', zip, '-C', dir]) // bsdtar reads zip on macOS and Windows 10+
  return dir
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

async function mac() {
  const out = join(root, 'vendor/ffmpeg/mac-arm64')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  for (const tool of ['ffmpeg', 'ffprobe']) {
    console.log(`mac-arm64: ${tool}`)
    const zip = await download(`${RIEDL}/${tool}.zip`)
    expectSum(zip, (await download(`${RIEDL}/${tool}.zip.sha256`)).toString(), `${tool}.zip`)
    const dir = unzip(zip, `${tool}.zip`)
    const bin = walk(dir).find((f) => f.endsWith(`/${tool}`))
    copyFileSync(bin, join(out, tool))
    chmodSync(join(out, tool), 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function win() {
  const out = join(root, 'vendor/ffmpeg/win-x64')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  console.log(`win-x64: ${WIN_ZIP}`)
  const zip = await download(`${BTBN}/${WIN_ZIP}`)
  expectSum(zip, (await download(`${BTBN}/checksums.sha256`)).toString(), WIN_ZIP)
  const dir = unzip(zip, WIN_ZIP)
  for (const f of walk(dir).filter((f) => /[\\/]bin[\\/][^\\/]+\.(exe|dll)$/i.test(f) && !/ffplay/i.test(f))) {
    copyFileSync(f, join(out, f.split(/[\\/]/).pop()))
  }
  for (const f of walk(dir).filter((f) => /LICENSE/i.test(f)).slice(0, 1)) copyFileSync(f, join(out, 'LICENSE.txt'))
  rmSync(dir, { recursive: true, force: true })
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['mac-arm64', 'win-x64']
for (const t of targets) {
  if (t === 'mac-arm64') await mac()
  else if (t === 'win-x64') await win()
  else throw new Error(`неизвестная цель ${t}`)
  console.log(`  → vendor/ffmpeg/${t}:`, readdirSync(join(root, 'vendor/ffmpeg', t)).join(', '))
}
if (!existsSync(join(root, 'vendor/ffmpeg'))) process.exit(1)
