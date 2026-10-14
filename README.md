# Audiobinder

**English** | [Русский](README.ru.md)

An audiobook builder for macOS and Windows — a modern replacement for Audiobook
Builder. Joins any audio files into an M4B, fills in the metadata, sets up chapters
(per file or from timestamps), and adds a cover and chapter images.

![Chapters](docs/screenshot-chapters.png)

## Features

- **Any source format**: MP3, M4A/M4B, FLAC, WAV, OGG/Opus, AAC, AIFF, WMA and
  anything else ffmpeg can read. Drag files and folders into the window; they're
  sorted the way Finder does it (2 before 10).
- **No length limit**: a single-file book of 100+ hours is fine. Long books are
  written with 64-bit MP4 atoms (tested on 40 h / 4.6 GB — Apple reads the
  duration and chapters correctly).
- **Metadata**: title, author, narrator, genre, year, description (in full, in
  `ldes`), publisher, copyright, comment, lyrics, encoder, cover. You choose which
  tags the author and narrator go into (Artist / Album Artist / Composer); the
  narrator is always duplicated into the Narrator tag (`©nrt`).
- **Chapters**:
  - one per file, from a file's embedded chapters, or anywhere inside a file;
  - "Chapter here" (`Глава здесь` in the UI) — a marker at the current player
    position (⌘M);
  - paste a list of timestamps ("0:00 Prologue", YouTube/Audible style, OGM);
  - merge, split by file, edit start times right in the table;
  - rename by template (`Глава {n}: {name}`, numbering, leading zeros);
  - an image for each chapter (QuickTime chapter images — shown in Apple Books
    and Music); chapters without an image show the cover.
- **Output**: M4B (audiobook, with bookmarks) or M4A; AAC or HE-AAC (Apple's
  encoder on macOS); quality presets or custom settings; **joining without
  re-encoding** when the sources are compatible AAC.
- **Splitting into parts** (optional): roughly every N hours with the break
  between chapters or files, exactly every N hours, or one file per chapter. A
  chapter that gets cut continues in the next part ("… (продолжение)", i.e.
  "continued").
- **Editing finished books**: open an M4B → fix chapters/tags/cover → rebuild
  (chapter images are extracted too).
- **Projects** (`.abproj`) — lightweight JSON with references to the files: save
  now, come back later; moving the folder together with the project doesn't
  break the paths.
- Undo/redo, preview playback that moves across files, light and dark themes,
  progress with a time estimate and cancel.

Missing compared to Audiobook Builder: importing from audio CDs and from the
Music/iTunes library (just drag the files in from Finder/File Explorer).

## Install

Prebuilt binaries are on the [Releases](https://github.com/megarohas/megarohas_audiobinder/releases/latest) page.

**macOS (Apple Silicon)** — `Audiobinder-<version>-mac-arm64.dmg` or `.zip`.
The app is ad-hoc signed (no Apple certificate), so after copying it to
Applications, clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Audiobinder.app
```

**Windows (x64)** — the `…-win-x64-setup.exe` installer or the portable
`…-win-x64-portable.exe`. SmartScreen may warn about an unknown publisher:
"More info" → "Run anyway".

ffmpeg is bundled with the app — no need to install it separately.

## Building from source

Requires Node.js 22+ and npm.

```bash
npm install
npm run fetch:ffmpeg      # static ffmpeg/ffprobe → vendor/ffmpeg/{mac-arm64,win-x64}
npm run dist:mac          # dist/*.dmg, dist/*.zip
npm run dist:win          # dist/*-setup.exe, dist/*-portable.exe (builds on macOS too)
```

Development: `npm run dev` (without `vendor/`, the system ffmpeg from PATH or
Homebrew is used). The icon is re-rendered from `resources/icon.svg`:
`npm run icon`.

### Checks

```bash
npm test                  # core: chapters, planning, building real files with ffmpeg
npm run typecheck
SMOKE_DIR=/path/to/mp3/folder npm run smoke   # invisible UI run with screenshots
swiftc -O tools/avcheck.swift -o build/avcheck && build/avcheck book.m4b   # what Apple sees
```

## How it works

```
src/core/      plain Node (no Electron), run directly by the tests
  probe.ts       ffprobe: duration, format, tags, embedded chapters
  chapters.ts    chapters are anchored to a file and an offset — they survive reordering files
  plan.ts        parts, pass-through check, tag layout, file names
  build.ts       decodes every file to PCM → a single AAC encoder (exact sample
                 counting, so chapters don't drift), or concat without re-encoding;
                 then ffmpeg writes the chapter track
  mp4.ts         custom MP4 atom editor: iTunes tags, cover, chapter-image track,
                 64-bit offsets; only rewrites the end of the file — audio isn't copied
  importer.ts    parses a finished M4B/MP3 back into a project
src/main/      Electron: window, menu, IPC, media:// protocol for preview
src/preload/   window.api bridge (contextIsolation + sandbox)
src/renderer/  React + zustand UI
```

## Licenses

Audiobinder's code is MIT. The distributions bundle [FFmpeg](https://ffmpeg.org):
an LGPL build by [BtbN](https://github.com/BtbN/FFmpeg-Builds) for Windows, and a
build by [Martin Riedl](https://ffmpeg.martin-riedl.de) for macOS; sources and
terms are on the projects' sites.
