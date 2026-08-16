import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkerAssetUrl } from './digital-human-shot-job'
import { buildHardCutFilter, safeTrimLeadingTrailingSilence } from '../media/clip-join'
import {
  apiBase,
  apiGet,
  apiPost,
  completeJob,
  completeStep,
  failStep,
  getJob,
  retryableForError,
  startStep,
  workerHeaders,
  type DurableJob,
} from './job-client'


type ClipAsset = { url: string; filename: string; media_type: string }

type StitchContext = {
  id: number
  project_id: number
  version: number
  status: string
  clips: ClipAsset[]
  video_asset_id?: number | null
}

type StitchApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<{ id: number }>
  completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
  failStep(jobId: number, stepId: number, error: unknown, retryable?: boolean): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  getRenderContext(renderId: number, jobId: number): Promise<StitchContext>
  updateRender(renderId: number, body: Record<string, unknown>, jobId: number): Promise<unknown>
  fetchLocalAsset(url: string, fallback: ClipAsset): Promise<{ bytes: Uint8Array }>
  saveVideoAsset(jobId: number, filename: string, bytes: Uint8Array): Promise<{ id: number; url: string }>
}

export type StitchJobDeps = {
  api: StitchApi
  concat(files: string[], output: string): Promise<void>
}

function latestStep(job: DurableJob, key: string) {
  return job.steps
    .filter(step => step.key === key)
    .sort((left, right) => right.attempt - left.attempt)[0]
}


async function runStep<T extends Record<string, unknown>>(
  jobId: number,
  key: string,
  deps: StitchJobDeps,
  work: () => Promise<T>,
) {
  const job = await deps.api.getJob(jobId)
  if (job.status === 'cancelled') throw new Error('任务已取消')
  const previous = latestStep(job, key)
  if (previous?.status === 'succeeded') return previous.output as T
  const step = previous?.status === 'running' && previous.id
    ? { id: previous.id }
    : await deps.api.startStep(jobId, key)
  try {
    const output = await work()
    await deps.api.completeStep(jobId, step.id, output)
    return output
  } catch (error) {
    await deps.api.failStep(jobId, step.id, error, retryableForError(error))
    throw error
  }
}


export function buildAcrossfadeFilter(count: number) {
  return { video: buildHardCutFilter(count), audio: '' }
}


export async function concatWithFfmpeg(files: string[], output: string) {
  if (files.length === 1) {
    await runFfmpeg(['-y', '-i', files[0], '-c', 'copy', output])
    return
  }
  await runFfmpeg([
    '-y',
    ...files.flatMap(file => ['-i', file]),
    '-filter_complex',
    buildHardCutFilter(files.length),
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    output,
  ])
}


function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出 ${code}: ${stderr.slice(-400)}`))
    })
  })
}


const defaultApi: StitchApi = {
  getJob,
  startStep,
  completeStep,
  failStep,
  completeJob,
  getRenderContext: (renderId, jobId) => apiGet(
    `/talking-videos/renders/${renderId}/worker-context`,
    workerHeaders(jobId),
  ),
  updateRender: (renderId, body, jobId) => apiPost(
    `/talking-videos/renders/${renderId}/worker-progress`,
    body,
    workerHeaders(jobId),
  ),
  async fetchLocalAsset(url, fallback) {
    const response = await fetch(resolveWorkerAssetUrl(url), {
      headers: workerHeaders(),
    })
    if (!response.ok) throw new Error(`无法读取镜头成片 (${response.status})`)
    return { bytes: new Uint8Array(await response.arrayBuffer()) }
  },
  async saveVideoAsset(jobId, filename, bytes) {
    const body = new FormData()
    const upload = new Uint8Array(bytes.byteLength)
    upload.set(bytes)
    body.set('file', new Blob([upload], { type: 'video/mp4' }), filename)
    const response = await fetch(
      `${apiBase()}/assets/upload?media_kind=video&title=${encodeURIComponent(filename)}`,
      { method: 'POST', headers: workerHeaders(jobId), body },
    )
    if (!response.ok) throw new Error(`成片本地保存失败 (${response.status})`)
    return response.json() as Promise<{ id: number; url: string }>
  },
}


export async function runDigitalHumanStitchJob(
  jobId: number,
  providedDeps?: StitchJobDeps,
) {
  const deps = providedDeps ?? { api: defaultApi, concat: concatWithFfmpeg }
  const job = await deps.api.getJob(jobId)
  const renderId = Number(job.input.render_id)
  try {
    const context = await deps.api.getRenderContext(renderId, jobId)
    if (!context.clips?.length) throw new Error('成片没有可拼接的镜头')
    await deps.api.updateRender(renderId, { status: 'running' }, jobId)
    const result = await runStep(jobId, 'concat_shots', deps, async () => {
      if (context.video_asset_id) return { video_asset_id: context.video_asset_id }
      const directory = await mkdtemp(join(tmpdir(), 'wms-stitch-'))
      try {
        const files: string[] = []
        for (const [index, clip] of context.clips.entries()) {
          const downloaded = await deps.api.fetchLocalAsset(clip.url, clip)
          const trimmed = await safeTrimLeadingTrailingSilence(downloaded.bytes)
          const file = join(directory, `${index}.mp4`)
          await writeFile(file, trimmed)
          files.push(file)
        }
        const output = join(directory, 'out.mp4')
        await deps.concat(files, output)
        const { readFile } = await import('node:fs/promises')
        const bytes = await readFile(output)
        const asset = await deps.api.saveVideoAsset(
          jobId,
          `talking-video-${renderId}.mp4`,
          new Uint8Array(bytes),
        )
        return { video_asset_id: asset.id }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
    await runStep(jobId, 'save_talking_video', deps, async () => {
      await deps.api.updateRender(renderId, {
        status: 'succeeded',
        video_asset_id: result.video_asset_id,
        error: '',
      }, jobId)
      return result
    })
    await deps.api.completeJob(jobId)
  } catch (error) {
    if (Number.isSafeInteger(renderId) && renderId > 0) {
      try {
        await deps.api.updateRender(renderId, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }, jobId)
      } catch {
        // Preserve the original stitch failure if status update fails.
      }
    }
    throw error
  }
}
