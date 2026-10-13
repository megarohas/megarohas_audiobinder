// Locating and running ffmpeg/ffprobe.

import { spawn, type ChildProcess } from 'node:child_process'

export interface Tools {
  ffmpeg: string
  ffprobe: string
}

let tools: Tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

export function setTools(t: Tools): void {
  tools = t
  caps = undefined
}

export function getTools(): Tools {
  return tools
}

export function spawnTool(which: keyof Tools, args: string[]): ChildProcess {
  return spawn(tools[which], args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

export class ToolError extends Error {
  stderr: string
  constructor(message: string, stderr: string) {
    super(message)
    this.stderr = stderr
  }
}

/** Runs a tool to completion and returns stdout; rejects with stderr on failure. */
export function runTool(which: keyof Tools, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawnTool(which, args)
    const out: Buffer[] = []
    const err: Buffer[] = []
    p.stdout!.on('data', (d: Buffer) => out.push(d))
    p.stderr!.on('data', (d: Buffer) => err.push(d))
    const onAbort = () => p.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    p.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new ToolError(`Не удалось запустить ${which}: ${e.message}`, ''))
    })
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      const stderr = Buffer.concat(err).toString('utf8').trim()
      if (signal?.aborted) reject(new AbortError())
      else if (code === 0) resolve(Buffer.concat(out))
      else reject(new ToolError(lastLines(stderr) || `${which} завершился с кодом ${code}`, stderr))
    })
  })
}

export class AbortError extends Error {
  constructor() {
    super('Отменено')
    this.name = 'AbortError'
  }
}

export function lastLines(s: string, n = 4): string {
  return s.split(/\r?\n/).filter(Boolean).slice(-n).join('\n')
}

export interface Capabilities {
  appleAac: boolean // aac_at (AudioToolbox) is available — better AAC and HE-AAC
  version: string
}

let caps: Capabilities | undefined

export async function capabilities(): Promise<Capabilities> {
  if (caps) return caps
  const [enc, ver] = await Promise.all([
    runTool('ffmpeg', ['-hide_banner', '-encoders']).then((b) => b.toString()),
    runTool('ffmpeg', ['-hide_banner', '-version']).then((b) => b.toString()),
  ])
  caps = {
    appleAac: /^\s*A\S*\s+aac_at\b/m.test(enc),
    version: ver.split('\n')[0].replace(/^ffmpeg version\s+/, '').split(' ')[0],
  }
  return caps
}
