import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


export type SilenceWindow = { start: number; end: number }

const LEADING_PAD = 0.08
const TRAILING_PAD = 0.08
const MIN_KEEP_SECONDS = 1


export function parseSilenceWindows(stderr: string): SilenceWindow[] {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)]
    .map(match => Number(match[1]))
  const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)]
    .map(match => Number(match[1]))
  const windows: SilenceWindow[] = []
  const count = Math.min(starts.length, ends.length)
  for (let index = 0; index < count; index += 1) {
    if (Number.isFinite(starts[index]) && Number.isFinite(ends[index])) {
      windows.push({ start: starts[index], end: ends[index] })
    }
  }
  if (starts.length === ends.length + 1 && Number.isFinite(starts[starts.length - 1])) {
    windows.push({ start: starts[starts.length - 1], end: Number.POSITIVE_INFINITY })
  }
  return windows
}


export function speechBounds(
  duration: number,
  windows: SilenceWindow[],
  pad = { lead: LEADING_PAD, trail: TRAILING_PAD },
) {
  let start = 0
  let end = duration
  const first = windows[0]
  if (first && first.start <= 0.05) {
    start = Math.max(0, first.end - pad.lead)
  }
  const last = windows[windows.length - 1]
  if (last && last.end >= duration - 0.12) {
    end = Math.min(duration, last.start + pad.trail)
  }
  if (!Number.isFinite(end) || end - start < MIN_KEEP_SECONDS) {
    return { start: 0, end: duration }
  }
  return { start, end }
}


export function buildHardCutFilter(count: number) {
  if (count <= 1) return '[0:v]copy[v];[0:a]acopy[a]'
  return `${Array.from({ length: count }, (_, index) => `[${index}:v][${index}:a]`).join('')}`
    + `concat=n=${count}:v=1:a=1[v][a]`
}


function runFfmpeg(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg 退出 ${code}: ${stderr.slice(-400)}`))
    })
  })
}


async function probeDuration(path: string) {
  const stderr = await runFfmpeg(['-i', path, '-f', 'null', '-'])
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}


export async function detectSpeechBounds(path: string) {
  let stderr = ''
  try {
    stderr = await runFfmpeg([
      '-i', path,
      '-af', 'silencedetect=noise=-35dB:d=0.25',
      '-f', 'null',
      '-',
    ])
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error)
  }
  const duration = await probeDuration(path)
  return speechBounds(duration, parseSilenceWindows(stderr))
}


export async function safeTrimLeadingTrailingSilence(bytes: Uint8Array) {
  try {
    return await trimLeadingTrailingSilence(bytes)
  } catch {
    return bytes
  }
}


export async function trimLeadingTrailingSilence(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'wms-clip-trim-'))
  const input = join(directory, 'in.mp4')
  const output = join(directory, 'out.mp4')
  try {
    await writeFile(input, bytes)
    const bounds = await detectSpeechBounds(input)
    const duration = await probeDuration(input)
    if (bounds.start <= 0.02 && bounds.end >= duration - 0.02) {
      return bytes
    }
    await runFfmpeg([
      '-y',
      '-ss', bounds.start.toFixed(3),
      '-to', bounds.end.toFixed(3),
      '-i', input,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      output,
    ])
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}


export function lastFrameExtractArgs(input: string, output: string, seekFromEnd = 0.5) {
  return [
    '-y',
    '-sseof',
    `-${seekFromEnd}`,
    '-i',
    input,
    '-update',
    '1',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    output,
  ]
}


export function lastFrameSeekArgs(input: string, output: string, at: number) {
  return [
    '-y',
    '-i',
    input,
    '-ss',
    Math.max(0, at).toFixed(3),
    '-update',
    '1',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    output,
  ]
}


export async function extractLastFrame(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'wms-clip-frame-'))
  const input = join(directory, 'in.mp4')
  const output = join(directory, 'frame.jpg')
  try {
    await writeFile(input, bytes)
    try {
      await runFfmpeg(lastFrameExtractArgs(input, output))
      return new Uint8Array(await readFile(output))
    } catch {
      const duration = await probeDuration(input)
      const at = duration > 0.08 ? duration - 0.05 : 0
      await runFfmpeg(lastFrameSeekArgs(input, output, at))
      return new Uint8Array(await readFile(output))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}


export async function extractTalkingFrame(bytes: Uint8Array) {
  return extractLastFrame(bytes)
}
