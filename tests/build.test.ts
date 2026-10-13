import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addChapterAt, chaptersPerFile, timeline } from '../src/core/chapters.ts'
import { buildBook } from '../src/core/build.ts'
import { runTool, capabilities } from '../src/core/ffmpeg.ts'
import { importBook } from '../src/core/importer.ts'
import { getTags, readMoov } from '../src/core/mp4.ts'
import { expandPaths, probeFile, probeMany } from '../src/core/probe.ts'
import { loadProject, saveProject } from '../src/core/project.ts'
import { emptyProject, type Project } from '../src/core/types.ts'

let dir = ''
const ff = (...args: string[]) => runTool('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args])
const tone = (freq: number, secs: number, rate = 44100) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}:sample_rate=${rate}`]

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abtest-'))
  await ff(...tone(440, 7), '-c:a', 'libmp3lame', '-b:a', '64k', join(dir, '01 Первая.mp3'))
  await ff(...tone(660, 5, 48000), '-ac', '2', join(dir, '02 Вторая.flac'))
  await ff(...tone(880, 6), '-c:a', 'aac', '-b:a', '96k', join(dir, '10 Третья.m4a'))
  for (const [i, f] of [[1, 300], [2, 400], [3, 500]] as const) {
    await ff(...tone(f, 4), '-c:a', 'aac', '-b:a', '64k', '-ac', '1', join(dir, `aac${i}.m4a`))
  }
  for (const c of ['red', 'green']) await ff('-f', 'lavfi', '-i', `color=c=${c}:s=320x200`, '-frames:v', '1', join(dir, `${c}.png`))
  await ff('-f', 'lavfi', '-i', 'color=c=orange:s=500x500', '-frames:v', '1', join(dir, 'cover.jpg'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function project(paths: string[]): Promise<Project> {
  const p = emptyProject()
  const { results, errors } = await probeMany(paths, 'filename')
  assert.deepEqual(errors, [])
  p.files = results.map((r) => r.file)
  p.chapters = chaptersPerFile(p.files)
  Object.assign(p.meta, { title: 'Тестовая книга', author: 'Автор Авторов', narrator: 'Чтец Чтецов', genre: 'Фэнтези', year: '2026' })
  return p
}

async function chaptersOf(file: string): Promise<{ start: number; title: string }[]> {
  const out = await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', file])
  return (JSON.parse(out.toString()).chapters as { start_time: string; tags: { title: string } }[]).map((c) => ({
    start: Number(c.start_time),
    title: c.tags.title,
  }))
}

test('folders expand recursively in natural order', async () => {
  const paths = await expandPaths([dir])
  assert.deepEqual(paths.map((p) => p.slice(dir.length + 1)), ['01 Первая.mp3', '02 Вторая.flac', '10 Третья.m4a', 'aac1.m4a', 'aac2.m4a', 'aac3.m4a'])
})

test('probe reads duration and format', async () => {
  const r = await probeFile(join(dir, '02 Вторая.flac'), 'filename')
  assert.equal(r.file.name, '02 Вторая')
  assert.equal(r.file.codec, 'flac')
  assert.equal(r.file.sampleRate, 48000)
  assert.ok(Math.abs(r.file.duration - 5) < 0.01)
})

test('mixed formats encode into one m4b with exact chapters, tags, cover and chapter art', async () => {
  const p = await project([join(dir, '01 Первая.mp3'), join(dir, '02 Вторая.flac'), join(dir, '10 Третья.m4a')])
  p.chapters = addChapterAt(p, 15, 'Внутри третьего файла').chapters
  p.chapters[0].image = join(dir, 'red.png')
  p.chapters[1].image = join(dir, 'green.png')
  p.meta.cover = join(dir, 'cover.jpg')
  p.meta.description = 'Описание; со = спецсимволами # и \\ слешем'
  const out = join(dir, 'out1')
  await runTool('ffmpeg', ['-version']).then(() => rm(out, { recursive: true, force: true }))
  await import('node:fs/promises').then((m) => m.mkdir(out))
  const seen: number[] = []
  const r = await buildBook({ project: p, outputDir: out, tool: 'Audiobinder test', onProgress: (x) => seen.push(x.fraction) })
  assert.equal(r.passthrough, false)
  assert.deepEqual(r.outputs, [join(out, 'Автор Авторов - Тестовая книга.m4b')])
  assert.equal(seen.at(-1), 1)

  const ch = await chaptersOf(r.outputs[0])
  assert.deepEqual(ch.map((c) => c.title), ['01 Первая', '02 Вторая', '10 Третья', 'Внутри третьего файла'])
  for (const [got, want] of ch.map((c, i) => [c.start, [0, 7, 12, 15][i]])) assert.ok(Math.abs(got - want) < 0.03, `${got} ≈ ${want}`)

  const { text, cover } = getTags(await readMoov(r.outputs[0]))
  assert.equal(text['©nam'], 'Тестовая книга')
  assert.equal(text['©ART'], 'Автор Авторов')
  assert.equal(text['©wrt'], 'Чтец Чтецов')
  assert.equal(text['©nrt'], 'Чтец Чтецов')
  assert.equal(text['ldes'], p.meta.description)
  assert.equal(cover?.format, 'jpeg')

  // Round trip: import the result back.
  const imp = await importBook(r.outputs[0], join(dir, 'cache'))
  assert.equal(imp.meta.title, 'Тестовая книга')
  assert.equal(imp.meta.narrator, 'Чтец Чтецов')
  assert.equal(imp.meta.description, p.meta.description)
  assert.ok(imp.meta.cover)
  assert.deepEqual(imp.chapters.map((c) => c.title), ch.map((c) => c.title))
  assert.equal(imp.chapters.filter((c) => c.image).length, 4, 'every chapter gets art (cover as fallback)')
  const left = await readdir(out)
  assert.deepEqual(left, ['Автор Авторов - Тестовая книга.m4b'], 'no temp files left behind')
})

test('compatible AAC sources are joined without re-encoding', async () => {
  const p = await project([1, 2, 3].map((i) => join(dir, `aac${i}.m4a`)))
  const out = join(dir, 'out2')
  await import('node:fs/promises').then((m) => m.mkdir(out))
  const r = await buildBook({ project: p, outputDir: out, tool: 't' })
  assert.equal(r.passthrough, true)
  const ch = await chaptersOf(r.outputs[0])
  const starts = timeline(p).map((c) => c.start)
  ch.forEach((c, i) => assert.ok(Math.abs(c.start - starts[i]) < 0.03))
  const probe = await probeFile(r.outputs[0], 'tag')
  assert.ok(Math.abs(probe.file.duration - 12) < 0.1)
})

test('exact parts split mid-file and continue the chapter', async () => {
  const p = await project([join(dir, '01 Первая.mp3'), join(dir, '02 Вторая.flac')])
  p.build.partsMode = 'exact'
  p.build.partHours = 5 / 3600
  const out = join(dir, 'out3')
  await import('node:fs/promises').then((m) => m.mkdir(out))
  const r = await buildBook({ project: p, outputDir: out, tool: 't' })
  assert.equal(r.outputs.length, 3)
  assert.match(r.outputs[0], /\(часть 1\)\.m4b$/)
  const second = await chaptersOf(r.outputs[1])
  assert.deepEqual(second.map((c) => c.title), ['01 Первая (продолжение)', '02 Вторая'])
  assert.ok(Math.abs(second[1].start - 2) < 0.05)
  const durs = await Promise.all(r.outputs.map(async (f) => (await probeFile(f, 'tag')).file.duration))
  assert.ok(Math.abs(durs.reduce((a, b) => a + b, 0) - 12) < 0.2, String(durs))
  const { text } = getTags(await readMoov(r.outputs[1]))
  assert.equal(text['©nam'], 'Тестовая книга (часть 2 из 3)')
})

test('HE-AAC encoding when Apple AAC is available', async (t) => {
  if (!(await capabilities()).appleAac) return t.skip('aac_at not available')
  const p = await project([join(dir, '01 Первая.mp3')])
  Object.assign(p.build, { encoder: 'he-aac', bitrate: 32, channels: 1, sampleRate: 32000 })
  const out = join(dir, 'out4')
  await import('node:fs/promises').then((m) => m.mkdir(out))
  const r = await buildBook({ project: p, outputDir: out, tool: 't' })
  const probe = await probeFile(r.outputs[0], 'tag')
  assert.equal(probe.file.profile, 'HE-AAC')
})

test('cancel stops the build and cleans up', async () => {
  const p = await project([join(dir, '01 Первая.mp3'), join(dir, '02 Вторая.flac')])
  const out = join(dir, 'out5')
  await import('node:fs/promises').then((m) => m.mkdir(out))
  const ac = new AbortController()
  const run = buildBook({ project: p, outputDir: out, tool: 't', signal: ac.signal, onProgress: (x) => x.stage === 'encode' && ac.abort() })
  await assert.rejects(run, /Отменено/)
  assert.deepEqual(await readdir(out), [])
})

test('project files survive moving the folder', async () => {
  const p = await project([join(dir, 'aac1.m4a')])
  const f = join(dir, 'book.abproj')
  await saveProject(p, f)
  const { project: q, missing } = await loadProject(f)
  assert.deepEqual(missing, [])
  assert.deepEqual(q.files.map((x) => x.path), p.files.map((x) => x.path))
})
