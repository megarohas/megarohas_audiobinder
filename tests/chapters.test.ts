import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addChapterAt, applyChapterList, chaptersPerFile, formatTime, joinChapters, locate, parseChapterList,
  parseTime, removeFiles, renameChapters, splitByFiles, timeline,
} from '../src/core/chapters.ts'
import { buildTags, passthroughCheck, planParts, safeFileName } from '../src/core/plan.ts'
import { defaultBuildOptions, emptyProject, type Project, type SourceFile } from '../src/core/types.ts'

function file(name: string, duration: number, extra: Partial<SourceFile> = {}): SourceFile {
  return {
    id: name, path: `/x/${name}.mp3`, name, duration, codec: 'mp3', profile: '', container: 'mp3',
    sampleRate: 44100, channels: 2, bitRate: 128000, tags: {}, ...extra,
  }
}

function book(durations: number[]): Project {
  const p = emptyProject()
  p.files = durations.map((d, i) => file(`f${i + 1}`, d))
  p.chapters = chaptersPerFile(p.files)
  return p
}

test('timeline places chapters by file anchors and follows file order', () => {
  const p = book([10, 20, 30])
  assert.deepEqual(timeline(p).map((c) => [c.title, c.start, c.end]), [['f1', 0, 10], ['f2', 10, 30], ['f3', 30, 60]])
  p.files = [p.files[2], p.files[0], p.files[1]]
  assert.deepEqual(timeline(p).map((c) => [c.title, c.start]), [['f3', 0], ['f1', 30], ['f2', 40]])
})

test('locate maps book time to file, boundary belongs to the next file', () => {
  const p = book([10, 20])
  assert.deepEqual(locate(p.files, 5), { fileId: 'f1', offset: 5 })
  assert.deepEqual(locate(p.files, 10), { fileId: 'f2', offset: 0 })
  assert.deepEqual(locate(p.files, 30), { fileId: 'f2', offset: 20 })
  assert.equal(locate(p.files, 31), undefined)
})

test('join merges consecutive runs, split restores file boundaries', () => {
  const p = book([10, 10, 10, 10])
  const ids = timeline(p).map((c) => c.id)
  p.chapters = joinChapters(p, [ids[0], ids[1], ids[3]])
  assert.deepEqual(timeline(p).map((c) => [c.title, c.duration]), [['f1', 20], ['f3', 10], ['f4', 10]])
  p.chapters = splitByFiles(p, [ids[0]])
  assert.deepEqual(timeline(p).map((c) => c.title), ['f1', 'f2', 'f3', 'f4'])
})

test('addChapterAt anchors inside a file and ignores duplicates', () => {
  const p = book([100])
  const r = addChapterAt(p, 42.5, 'Середина')
  p.chapters = r.chapters
  assert.deepEqual(timeline(p).map((c) => [c.title, c.start]), [['f1', 0], ['Середина', 42.5]])
  assert.equal(addChapterAt(p, 42.52).chapters.length, 2)
})

test('removing a file hands its chapter to the next uncovered file', () => {
  const p = book([10, 10, 10])
  const ids = timeline(p).map((c) => c.id)
  p.chapters = joinChapters(p, [ids[0], ids[1]]) // chapter f1 covers f1+f2
  const r = removeFiles(p, ['f1'])
  assert.deepEqual(timeline(r).map((c) => [c.title, c.fileId, c.start]), [['f1', 'f2', 0], ['f3', 'f3', 10]])
})

test('time parsing and formatting', () => {
  assert.equal(parseTime('1:02:03.5'), 3723.5)
  assert.equal(parseTime('02:03'), 123)
  assert.equal(parseTime('75'), 75)
  assert.equal(parseTime('0:61'), undefined)
  assert.equal(formatTime(3723.5, true), '1:02:03.500')
  assert.equal(formatTime(100 * 3600), '100:00:00')
})

test('chapter list parsing: timed, OGM, titles, mixed', () => {
  const timed = parseChapterList('0:00 Пролог\n[12:30] - Глава 1\n1:05:00 — Глава 2')
  assert.equal(timed.timed, true)
  assert.deepEqual(timed.entries, [{ time: 0, title: 'Пролог' }, { time: 750, title: 'Глава 1' }, { time: 3900, title: 'Глава 2' }])
  const ogm = parseChapterList('CHAPTER01=00:00:00.000\nCHAPTER01NAME=Один\nCHAPTER02=00:10:00.500\nCHAPTER02NAME=Два')
  assert.deepEqual(ogm.entries, [{ time: 0, title: 'Один' }, { time: 600.5, title: 'Два' }])
  const titles = parseChapterList('Пролог\n1. Начало\n')
  assert.equal(titles.timed, false)
  assert.deepEqual(titles.entries.map((e) => e.title), ['Пролог', '1. Начало'])
  assert.equal(parseChapterList('0:00 a\nb').errors.length, 1)
})

test('applying lists: timed replaces, untimed renames in order', () => {
  const p = book([60, 60])
  const r = applyChapterList(p, parseChapterList('0:00 A\n0:30 B\n1:30 C\n5:00 Z'))
  assert.equal(r.warnings.length, 1)
  p.chapters = r.chapters
  assert.deepEqual(timeline(p).map((c) => [c.title, c.fileId, c.offset]), [['A', 'f1', 0], ['B', 'f1', 30], ['C', 'f2', 30]])
  p.chapters = applyChapterList(p, parseChapterList('X\nY\nZ')).chapters
  assert.deepEqual(timeline(p).map((c) => c.title), ['X', 'Y', 'Z'])
})

test('rename by template with padding and count', () => {
  const p = book([1, 1, 1])
  p.meta.title = 'Книга'
  const ids = timeline(p).map((c) => c.id)
  p.chapters = renameChapters(p, ids, { template: '{title}: {n}/{N} {name}', start: 1, pad: 2, bookTitle: 'Книга' })
  assert.deepEqual(timeline(p).map((c) => c.title), ['Книга: 01/03 f1', 'Книга: 02/03 f2', 'Книга: 03/03 f3'])
})

test('parts planning in every mode', () => {
  const p = book([3600, 3600, 3600, 3600, 3600])
  const o = { ...defaultBuildOptions(), partHours: 2 }
  assert.equal(planParts(p, o).length, 1)
  assert.deepEqual(planParts(p, { ...o, partsMode: 'files' }).map((x) => [x.start, x.end]), [[0, 7200], [7200, 14400], [14400, 18000]])
  assert.deepEqual(planParts(p, { ...o, partsMode: 'chapters' }).map((x) => x.chapters.length), [2, 2, 1])
  assert.equal(planParts(p, { ...o, partsMode: 'perChapter' }).length, 5)
  const exact = planParts(p, { ...o, partsMode: 'exact', partHours: 1.5 })
  assert.deepEqual(exact.map((x) => x.start), [0, 5400, 10800, 16200])
  assert.deepEqual(exact[1].from, { fileIndex: 1, offset: 1800 })
})

test('pass-through eligibility', () => {
  const p = emptyProject()
  const aac = { codec: 'aac', profile: 'LC', container: 'mov,mp4,m4a,3gp,3g2,mj2' }
  p.files = [file('a', 10, aac), file('b', 10, aac)]
  p.chapters = chaptersPerFile(p.files)
  assert.equal(passthroughCheck(p, defaultBuildOptions()).ok, true)
  assert.equal(passthroughCheck(p, { ...defaultBuildOptions(), partsMode: 'exact' }).ok, false)
  p.files[1] = { ...p.files[1], sampleRate: 22050 }
  assert.equal(passthroughCheck(p, defaultBuildOptions()).ok, false)
})

test('tag mapping merges people sharing a tag', () => {
  const p = emptyProject()
  Object.assign(p.meta, { title: 'T', author: 'Автор', narrator: 'Чтец', description: 'x'.repeat(300) })
  const o = { ...defaultBuildOptions(), narratorTags: ['composer', 'artist'] as const }
  const tags = buildTags(p.meta, { ...o, narratorTags: [...o.narratorTags] }, { tool: 'test' })
  const get = (a: string) => tags.find((t) => t.atom === a)?.value
  assert.deepEqual(get('©ART'), { kind: 'text', value: 'Автор, Чтец' })
  assert.deepEqual(get('aART'), { kind: 'text', value: 'Автор' })
  assert.deepEqual(get('©wrt'), { kind: 'text', value: 'Чтец' })
  assert.equal((get('desc') as { value: string }).value.length, 255)
  assert.deepEqual(get('stik'), { kind: 'int8', value: 2 })
})

test('file names are safe on Windows', () => {
  assert.equal(safeFileName('a<b>:c"d/e\\f|g?h*. '), 'a b c d e f g h')
  assert.equal(safeFileName('CON'), 'Аудиокнига')
})
