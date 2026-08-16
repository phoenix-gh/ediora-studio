import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import Redis from 'ioredis'

import { runContentJob } from '../lib/ai/content-job'
import { runDailyCreationAgentJob } from '../lib/ai/daily-creation-agent-job'
import {
  JobFinalizationError,
  runDigitalHumanRenderJob,
  runDigitalHumanSetupJob,
} from '../lib/ai/digital-human-job'
import { runDigitalHumanShotRenderJob } from '../lib/ai/digital-human-shot-job'
import { runDigitalHumanStitchJob } from '../lib/ai/digital-human-stitch-job'
import {
  apiPost,
  ApiRequestError,
  failStep,
  getJob,
  startStep,
  workerHeaders,
  type DurableJob,
} from '../lib/ai/job-client'
import { runContentResponseAnalysisJob } from '../lib/ai/content-response-job'
import { runContentResponseOutputJob } from '../lib/ai/content-response-output-job'
import { runTopicSourceJob } from '../lib/ai/topic-source-job'
import { runTextVideoSplitJob } from '../lib/ai/text-video-split-job'
import { runTextVideoMasterJob } from '../lib/ai/text-video-master-job'
import { runTextVideoRenderJob } from '../lib/ai/text-video-render-job'
import { runTextVideoSceneJob } from '../lib/ai/text-video-scene-job'
import { runTextVideoSpeechJob } from '../lib/ai/text-video-speech-job'


const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'cancelled', 'failed'])
const UNSUPPORTED_TEXT_VIDEO_STEP = 'unsupported_text_video_flow'
export const LONG_VIDEO_FLOWS = new Set([
  'digital_human_shot_render',
  'digital_human_stitch',
  'digital_human_render',
  'text_video_render',
])

export function isLongVideoFlow(flow: string) {
  return LONG_VIDEO_FLOWS.has(flow)
}

export function workerQueueForFlow(
  flow: string,
  queues: { defaultQueue: string; videoQueue: string },
) {
  return isLongVideoFlow(flow) ? queues.videoQueue : queues.defaultQueue
}
const DEFAULT_LEASE_TTL_MS = 30_000
const DEFAULT_LEASE_REFRESH_INTERVAL_MS = 10_000
const DEFAULT_BLOCK_TIMEOUT_SECONDS = 1

const COMPARE_PEXPIRE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

const COMPARE_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

const ENQUEUE_ONCE_SCRIPT = `
if redis.call('LPOS', KEYS[1], ARGV[1]) then
  return 0
end
return redis.call('RPUSH', KEYS[1], ARGV[1])
`

export type ContentJobRunner = (jobId: number) => Promise<unknown>

type UnsupportedTextVideoApi = {
  getJob(jobId: number): Promise<DurableJob>
  startStep(jobId: number, step: string): Promise<{ id: number }>
  failStep(
    jobId: number,
    stepId: number,
    error: unknown,
    retryable?: boolean,
  ): Promise<unknown>
}

export type ContentJobRunnerDependencies = {
  speechFetch?: typeof fetch
  unsupportedTextVideoApi?: UnsupportedTextVideoApi
}

export class UnsupportedTextVideoFlowError extends Error {
  constructor(flow: string) {
    super(`Unsupported text-video content flow: ${flow}`)
    this.name = 'UnsupportedTextVideoFlowError'
  }
}

async function runUnsupportedTextVideoJob(
  jobId: number,
  flow: string,
  api: UnsupportedTextVideoApi,
) {
  const job = await api.getJob(jobId)
  if (TERMINAL_JOB_STATUSES.has(job.status)) return
  const previous = job.steps
    .filter(step => step.key === UNSUPPORTED_TEXT_VIDEO_STEP)
    .sort((left, right) => right.attempt - left.attempt)[0]
  const step = previous?.status === 'running' && previous.id
    ? { id: previous.id }
    : await api.startStep(jobId, UNSUPPORTED_TEXT_VIDEO_STEP)
  const error = new UnsupportedTextVideoFlowError(flow)
  await api.failStep(jobId, step.id, error, false)
  throw error
}

const defaultUnsupportedTextVideoApi: UnsupportedTextVideoApi = {
  getJob,
  startStep,
  failStep,
}

export function resolveContentJobRunner(
  flow: string,
  dependencies: ContentJobRunnerDependencies = {},
): ContentJobRunner {
  if (flow === 'daily_creation') return runDailyCreationAgentJob
  if (flow === 'digital_human_setup') return runDigitalHumanSetupJob
  if (flow === 'digital_human_render') return runDigitalHumanRenderJob
  if (flow === 'digital_human_shot_render') return runDigitalHumanShotRenderJob
  if (flow === 'digital_human_stitch') return runDigitalHumanStitchJob
  if (flow === 'content_response_analysis') {
    return runContentResponseAnalysisJob
  }
  if (flow === 'content_response_output') return runContentResponseOutputJob
  if (flow === 'topic_source') return runTopicSourceJob
  if (flow === 'text_video_split_preview') return runTextVideoSplitJob
  if (flow === 'text_video_speech') {
    if (!dependencies.speechFetch) return runTextVideoSpeechJob
    return jobId => runTextVideoSpeechJob(
      jobId,
      undefined,
      dependencies.speechFetch,
    )
  }
  if (flow === 'text_video_master_audio') return runTextVideoMasterJob
  if (flow === 'text_video_scene_plan') return runTextVideoSceneJob
  if (flow === 'text_video_render') return runTextVideoRenderJob
  if (flow.startsWith('text_video_')) {
    return jobId => runUnsupportedTextVideoJob(
      jobId,
      flow,
      dependencies.unsupportedTextVideoApi
        ?? defaultUnsupportedTextVideoApi,
    )
  }
  return runContentJob
}

export type ContentWorkerRedis = {
  ping(): Promise<unknown>
  blpop(
    queueName: string,
    timeoutSeconds: number,
  ): Promise<[string, string] | null>
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<'OK' | null>
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>
}

type ReconcileContentJobs = () => Promise<unknown>
type ResolveContentJobRunner = (
  flow: string,
  dependencies?: ContentJobRunnerDependencies,
) => ContentJobRunner

export type RunContentWorkerOptions = {
  redis: ContentWorkerRedis
  queueName: string
  signal: AbortSignal
  speechFetch?: typeof fetch
  onReady?: () => void | Promise<void>
  reconcile?: ReconcileContentJobs
  getJob?: (jobId: number) => Promise<DurableJob>
  resolveRunner?: ResolveContentJobRunner
  leaseTtlMs?: number
  leaseRefreshIntervalMs?: number
  blockTimeoutSeconds?: number
  videoQueueName?: string
  defaultQueueName?: string
}

export type WorkerReconcileResult = {
  enqueued: number
  job_ids: number[]
}

export function reconcileContentJobs() {
  return apiPost<WorkerReconcileResult>(
    '/jobs/worker-reconcile',
    undefined,
    workerHeaders(),
  )
}

function leaseKey(queueName: string, jobId: number) {
  return `wms:content-job-lease:${queueName}:${jobId}`
}

async function acquireLease(
  redis: ContentWorkerRedis,
  key: string,
  owner: string,
  ttlMs: number,
) {
  return await redis.set(key, owner, 'PX', ttlMs, 'NX') === 'OK'
}

async function refreshLease(
  redis: ContentWorkerRedis,
  key: string,
  owner: string,
  ttlMs: number,
) {
  return Number(await redis.eval(
    COMPARE_PEXPIRE_SCRIPT,
    1,
    key,
    owner,
    String(ttlMs),
  )) === 1
}

async function releaseLease(
  redis: ContentWorkerRedis,
  key: string,
  owner: string,
) {
  return Number(await redis.eval(
    COMPARE_DELETE_SCRIPT,
    1,
    key,
    owner,
  )) === 1
}

async function enqueueOnce(
  redis: ContentWorkerRedis,
  queueName: string,
  jobId: number,
) {
  await redis.eval(
    ENQUEUE_ONCE_SCRIPT,
    1,
    queueName,
    String(jobId),
  )
}

function startLeaseRefresh(
  redis: ContentWorkerRedis,
  key: string,
  owner: string,
  ttlMs: number,
  intervalMs: number,
) {
  let active = true
  let confirmedUntil = Date.now() + ttlMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = Promise.resolve()

  const schedule = () => {
    const remainingMs = confirmedUntil - Date.now()
    if (remainingMs <= 0) {
      active = false
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      inFlight = refreshLease(redis, key, owner, ttlMs)
        .then(refreshed => {
          if (!refreshed) {
            active = false
            console.error(`content job lease ${key} was lost`)
            return
          }
          confirmedUntil = Date.now() + ttlMs
        })
        .catch(error => {
          console.error(`content job lease ${key} refresh failed`, error)
        })
        .finally(() => {
          if (active) schedule()
        })
    }, Math.max(1, Math.min(intervalMs, remainingMs)))
  }

  schedule()
  return async () => {
    active = false
    if (timer !== undefined) clearTimeout(timer)
    await inFlight
  }
}

function shouldRequeue(
  error: unknown,
  phase: 'loading' | 'running',
) {
  if (phase === 'loading' && !(error instanceof ApiRequestError)) return true
  return error instanceof JobFinalizationError
    || (error instanceof ApiRequestError && error.retryable)
}

async function runLeasedJob(
  jobId: number,
  options: Required<Pick<
    RunContentWorkerOptions,
    | 'redis'
    | 'queueName'
    | 'getJob'
    | 'resolveRunner'
    | 'leaseTtlMs'
    | 'leaseRefreshIntervalMs'
  >> & Pick<
    RunContentWorkerOptions,
    'speechFetch' | 'videoQueueName' | 'defaultQueueName'
  >,
) {
  const key = leaseKey(options.queueName, jobId)
  const owner = randomUUID()
  if (!await acquireLease(
    options.redis,
    key,
    owner,
    options.leaseTtlMs,
  )) return

  const stopRefresh = startLeaseRefresh(
    options.redis,
    key,
    owner,
    options.leaseTtlMs,
    options.leaseRefreshIntervalMs,
  )
  let retryError: unknown
  let released = false
  let phase: 'loading' | 'running' = 'loading'
  try {
    const job = await options.getJob(jobId)
    if (TERMINAL_JOB_STATUSES.has(job.status)) return
    const targetQueue = workerQueueForFlow(job.flow, {
      defaultQueue: options.defaultQueueName ?? options.queueName,
      videoQueue: options.videoQueueName ?? options.queueName,
    })
    if (targetQueue !== options.queueName) {
      await enqueueOnce(options.redis, targetQueue, jobId)
      return
    }
    phase = 'running'
    await options.resolveRunner(job.flow, {
      speechFetch: options.speechFetch,
    })(jobId)
  } catch (error) {
    retryError = shouldRequeue(error, phase) ? error : undefined
    console.error(`content job ${jobId} failed`, error)
  } finally {
    await stopRefresh()
    try {
      released = await releaseLease(options.redis, key, owner)
    } catch (error) {
      console.error(`content job ${jobId} lease release failed`, error)
    }
  }
  if (retryError !== undefined && released) {
    await enqueueOnce(options.redis, options.queueName, jobId)
  }
}

export async function runContentWorker({
  redis,
  queueName,
  signal,
  speechFetch,
  onReady = () => {},
  reconcile = reconcileContentJobs,
  getJob: loadJob = getJob,
  resolveRunner = resolveContentJobRunner,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  leaseRefreshIntervalMs = DEFAULT_LEASE_REFRESH_INTERVAL_MS,
  blockTimeoutSeconds = DEFAULT_BLOCK_TIMEOUT_SECONDS,
  videoQueueName,
  defaultQueueName,
}: RunContentWorkerOptions) {
  await redis.ping()
  await reconcile()
  if (signal.aborted) return
  await onReady()

  while (!signal.aborted) {
    const item = await redis.blpop(queueName, blockTimeoutSeconds)
    if (!item) continue
    const jobId = Number(item[1])
    if (!Number.isSafeInteger(jobId) || jobId <= 0) continue
    await runLeasedJob(jobId, {
      redis,
      queueName,
      getJob: loadJob,
      resolveRunner,
      leaseTtlMs,
      leaseRefreshIntervalMs,
      speechFetch,
      videoQueueName,
      defaultQueueName,
    })
  }
}

type WorkerReadyFileOptions = {
  readyFile?: string
  marker?: string
  configFingerprint?: string
}

export function createWorkerReadyFilePublisher({
  readyFile = '',
  marker = '',
  configFingerprint = '',
}: WorkerReadyFileOptions) {
  if (readyFile && (!marker || !configFingerprint)) {
    throw new Error(
      'WMS_WORKER_READY_FILE requires a non-empty marker and fingerprint',
    )
  }
  const payload = readyFile
    ? `marker=${marker}\nconfig_fingerprint=${configFingerprint}\n`
    : ''
  let published = false

  return {
    async publish() {
      if (!readyFile) return
      await mkdir(dirname(readyFile), { recursive: true })
      const temporary = `${readyFile}.tmp.${process.pid}.${randomUUID()}`
      try {
        await writeFile(temporary, payload, {
          encoding: 'utf8',
          mode: 0o600,
        })
        await rename(temporary, readyFile)
        published = true
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
    async cleanup() {
      if (!readyFile || !published) return
      try {
        if (await readFile(readyFile, 'utf8') === payload) {
          await rm(readyFile)
        }
      } catch (error) {
        if (
          !error
          || typeof error !== 'object'
          || !('code' in error)
          || error.code !== 'ENOENT'
        ) throw error
      }
    },
  }
}

async function runContentWorkerCli() {
  const redisUrl = process.env.WMS_REDIS_URL ?? 'redis://redis:6379/0'
  const queueName = process.env.WMS_WORKER_QUEUE ?? 'content-jobs'
  const videoQueueName = process.env.WMS_VIDEO_WORKER_QUEUE ?? 'content-jobs:video'
  const listenVideoQueue = process.env.WMS_LISTEN_VIDEO_QUEUE !== '0'
    && videoQueueName !== queueName
  const ready = createWorkerReadyFilePublisher({
    readyFile: process.env.WMS_WORKER_READY_FILE,
    marker: process.env.WMS_DEV_SERVICE_MARKER,
    configFingerprint: process.env.WMS_DEV_CONFIG_FINGERPRINT,
  })
  const redis = new Redis(redisUrl)
  const videoRedis = listenVideoQueue ? new Redis(redisUrl) : undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    await Promise.all([
      runContentWorker({
        redis,
        queueName,
        videoQueueName,
        defaultQueueName: queueName,
        signal: controller.signal,
        speechFetch: fetch,
        onReady: ready.publish,
        reconcile: reconcileContentJobs,
        getJob,
        resolveRunner: resolveContentJobRunner,
      }),
      videoRedis
        ? runContentWorker({
            redis: videoRedis,
            queueName: videoQueueName,
            videoQueueName,
            defaultQueueName: queueName,
            signal: controller.signal,
            speechFetch: fetch,
            reconcile: async () => ({ enqueued: 0, job_ids: [] }),
            getJob,
            resolveRunner: resolveContentJobRunner,
          })
        : Promise.resolve(),
    ])
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
    await ready.cleanup()
    redis.disconnect()
    videoRedis?.disconnect()
  }
}

export function isDirectContentWorkerEntry(
  entryPath: string | undefined,
  modulePath: string,
) {
  return Boolean(
    entryPath
    && resolve(entryPath) === resolve(modulePath),
  )
}

const modulePath = typeof __filename === 'string'
  ? __filename
  : resolve(process.cwd(), 'scripts/content-worker.ts')
if (isDirectContentWorkerEntry(process.argv[1], modulePath)) {
  void runContentWorkerCli().catch(error => {
    console.error('content worker stopped', error)
    process.exitCode = 1
  })
}
