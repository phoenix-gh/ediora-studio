import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runContentJob } from '../lib/ai/content-job'
import { runDailyCreationAgentJob } from '../lib/ai/daily-creation-agent-job'
import { JobFinalizationError } from '../lib/ai/digital-human-job'
import { ApiRequestError } from '../lib/ai/job-client'
import { runTextVideoMasterJob } from '../lib/ai/text-video-master-job'
import { runTextVideoRenderJob } from '../lib/ai/text-video-render-job'
import { runTextVideoSceneJob } from '../lib/ai/text-video-scene-job'
import { runTextVideoSpeechJob } from '../lib/ai/text-video-speech-job'
import { runTextVideoSplitJob } from '../lib/ai/text-video-split-job'


const redisConstructor = vi.hoisted(() => vi.fn())
const genericRunner = vi.hoisted(() => vi.fn())
const speechRunner = vi.hoisted(() => vi.fn())
const dailyAgentRunner = vi.hoisted(() => vi.fn())

vi.mock('ioredis', () => ({
  default: class ForbiddenImportRedis {
    constructor(...args: unknown[]) {
      redisConstructor(...args)
      throw new Error('content-worker connected to Redis during import')
    }
  },
}))

vi.mock('../lib/ai/content-job', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/ai/content-job')>(),
  runContentJob: genericRunner,
}))

vi.mock('../lib/ai/text-video-speech-job', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/ai/text-video-speech-job')>(),
  runTextVideoSpeechJob: speechRunner,
}))

vi.mock('../lib/ai/daily-creation-agent-job', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/ai/daily-creation-agent-job')>(),
  runDailyCreationAgentJob: dailyAgentRunner,
}))

type QueueItem = [string, string] | null
type PopAction = QueueItem | (() => QueueItem | Promise<QueueItem>)

type RedisState = {
  leases: Map<string, string>
  queue: string[]
  events: string[]
}

class FakeRedis {
  readonly state: RedisState
  readonly pops: PopAction[]
  readonly refreshActions: Array<Error | number> = []

  constructor(
    pops: PopAction[],
    state: RedisState = {
      leases: new Map(),
      queue: [],
      events: [],
    },
  ) {
    this.pops = [...pops]
    this.state = state
  }

  async ping() {
    this.state.events.push('ping')
    return 'PONG'
  }

  async blpop(queueName: string, timeoutSeconds: number) {
    this.state.events.push(`blpop:${queueName}:${timeoutSeconds}`)
    const action = this.pops.shift() ?? null
    return typeof action === 'function' ? action() : action
  }

  async set(
    key: string,
    owner: string,
    expiryMode: string,
    ttlMs: number,
    condition: string,
  ) {
    this.state.events.push(`acquire:${key}:${expiryMode}:${ttlMs}:${condition}`)
    if (this.state.leases.has(key)) return null
    this.state.leases.set(key, owner)
    return 'OK'
  }

  async eval(
    _script: string,
    _numberOfKeys: number,
    key: string,
    firstArgument: string,
    secondArgument?: string,
  ) {
    if (key.startsWith('wms:content-job-lease:')) {
      if (secondArgument !== undefined) {
        this.state.events.push(`refresh:${key}:${secondArgument}`)
        const action = this.refreshActions.shift()
        if (action instanceof Error) throw action
        if (action !== undefined) return action
        return this.state.leases.get(key) === firstArgument ? 1 : 0
      }
      this.state.events.push(`release:${key}`)
      if (this.state.leases.get(key) !== firstArgument) return 0
      this.state.leases.delete(key)
      return 1
    }
    this.state.events.push(`enqueue:${key}:${firstArgument}`)
    if (this.state.queue.includes(firstArgument)) return 0
    this.state.queue.push(firstArgument)
    return this.state.queue.length
  }
}

function durableJob(
  id: number,
  flow = 'content',
  status = 'queued',
) {
  return {
    id,
    flow,
    title: `job ${id}`,
    status,
    input: {},
    steps: [],
  }
}

function stopOnNextPop(controller: AbortController): PopAction {
  return () => {
    controller.abort()
    return null
  }
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  redisConstructor.mockClear()
  genericRunner.mockReset()
  speechRunner.mockReset()
})

describe('content worker dispatch', () => {
  it('is import-safe and explicitly dispatches every text-video flow', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const {
      isDirectContentWorkerEntry,
      resolveContentJobRunner,
    } = await import('./content-worker')

    expect(redisConstructor).not.toHaveBeenCalled()
    expect(timeoutSpy).not.toHaveBeenCalled()
    expect(isDirectContentWorkerEntry(
      '/repo/web/scripts/content-worker.ts',
      '/repo/web/scripts/content-worker.ts',
    )).toBe(true)
    expect(isDirectContentWorkerEntry(
      '/repo/web/node_modules/.bin/playwright',
      '/repo/web/scripts/content-worker.ts',
    )).toBe(false)
    expect(resolveContentJobRunner('text_video_split_preview'))
      .toBe(runTextVideoSplitJob)
    expect(resolveContentJobRunner('text_video_speech'))
      .toBe(runTextVideoSpeechJob)
    expect(resolveContentJobRunner('text_video_master_audio'))
      .toBe(runTextVideoMasterJob)
    expect(resolveContentJobRunner('text_video_scene_plan'))
      .toBe(runTextVideoSceneJob)
    expect(resolveContentJobRunner('text_video_render'))
      .toBe(runTextVideoRenderJob)
    expect(resolveContentJobRunner('content')).toBe(runContentJob)
    expect(resolveContentJobRunner('prompt_image_generation')).toBe(runContentJob)
    expect(resolveContentJobRunner('daily_creation'))
      .toBe(runDailyCreationAgentJob)
  })

  it('routes long video flows onto the dedicated video queue', async () => {
    const { isLongVideoFlow, workerQueueForFlow } = await import('./content-worker')

    expect(isLongVideoFlow('digital_human_shot_render')).toBe(true)
    expect(isLongVideoFlow('digital_human_stitch')).toBe(true)
    expect(isLongVideoFlow('digital_human_render')).toBe(true)
    expect(isLongVideoFlow('text_video_render')).toBe(true)
    expect(isLongVideoFlow('daily_creation')).toBe(false)
    expect(workerQueueForFlow('digital_human_shot_render', {
      defaultQueue: 'content-jobs',
      videoQueue: 'content-jobs:video',
    })).toBe('content-jobs:video')
    expect(workerQueueForFlow('daily_creation', {
      defaultQueue: 'content-jobs',
      videoQueue: 'content-jobs:video',
    })).toBe('content-jobs')
  })

  it('requeues a long video job from the default worker without running it', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '88'],
      stopOnNextPop(controller),
    ])
    const runner = vi.fn()
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis,
      queueName: 'content-jobs',
      videoQueueName: 'content-jobs:video',
      defaultQueueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(88, 'digital_human_shot_render')),
      resolveRunner: () => runner,
    })

    expect(runner).not.toHaveBeenCalled()
    expect(redis.state.events).toContain('enqueue:content-jobs:video:88')
    expect(redis.state.leases.size).toBe(0)
  })

  it('runs a long video job when the video worker owns it', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs:video', '89'],
      stopOnNextPop(controller),
    ])
    const runner = vi.fn()
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis,
      queueName: 'content-jobs:video',
      videoQueueName: 'content-jobs:video',
      defaultQueueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(89, 'digital_human_shot_render')),
      resolveRunner: () => runner,
    })

    expect(runner).toHaveBeenCalledWith(89)
    expect(redis.state.events.filter(event => event.startsWith('enqueue:'))).toEqual([])
  })

  it('dispatches a loaded daily job without a runtime version dependency', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '18'],
      stopOnNextPop(controller),
    ])
    const runner = vi.fn()
    const resolveRunner = vi.fn(() => runner)
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis, queueName: 'content-jobs', signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue({
        ...durableJob(18, 'daily_creation'),
        input: { run_id: 8 },
      }),
      resolveRunner,
    })

    expect(resolveRunner).toHaveBeenCalledWith('daily_creation', {
      speechFetch: undefined,
    })
    expect(runner).toHaveBeenCalledWith(18)
  })

  it('durably rejects unknown text-video flows without using the generic runner', async () => {
    const unsupportedApi = {
      getJob: vi.fn().mockResolvedValue(
        durableJob(17, 'text_video_future'),
      ),
      startStep: vi.fn().mockResolvedValue({ id: 71 }),
      failStep: vi.fn().mockResolvedValue({}),
    }
    const { resolveContentJobRunner } = await import('./content-worker')

    const runner = resolveContentJobRunner('text_video_future', {
      unsupportedTextVideoApi: unsupportedApi,
    })

    await expect(runner(17)).rejects.toMatchObject({
      name: 'UnsupportedTextVideoFlowError',
    })
    expect(unsupportedApi.startStep).toHaveBeenCalledWith(
      17,
      'unsupported_text_video_flow',
    )
    expect(unsupportedApi.failStep).toHaveBeenCalledWith(
      17,
      71,
      expect.objectContaining({
        message: 'Unsupported text-video content flow: text_video_future',
      }),
      false,
    )
    expect(genericRunner).not.toHaveBeenCalled()
  })

  it('routes speechFetch only through the text-video speech runner seam', async () => {
    const speechFetch = vi.fn<typeof fetch>()
    const { resolveContentJobRunner } = await import('./content-worker')

    await resolveContentJobRunner(
      'text_video_speech',
      { speechFetch },
    )(29)

    expect(speechRunner).toHaveBeenCalledWith(29, undefined, speechFetch)
    expect(resolveContentJobRunner('text_video_scene_plan', { speechFetch }))
      .toBe(runTextVideoSceneJob)
  })
})

describe('content worker lifecycle', () => {
  it('pings and reconciles before publishing readiness', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([stopOnNextPop(controller)])
    const order: string[] = []
    const reconcile = vi.fn(async () => {
      order.push('reconcile')
    })
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile,
      onReady: async () => {
        order.push('ready')
      },
    })

    expect(redis.state.events[0]).toBe('ping')
    expect(order).toEqual(['reconcile', 'ready'])
    expect(reconcile).toHaveBeenCalledWith()
    expect(redis.state.events).toContain('blpop:content-jobs:1')
  })

  it('does not publish readiness when initial reconciliation fails', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([])
    const onReady = vi.fn()
    const { runContentWorker } = await import('./content-worker')

    await expect(runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: async () => {
        throw new Error('reconcile unavailable')
      },
      onReady,
    })).rejects.toThrow('reconcile unavailable')

    expect(onReady).not.toHaveBeenCalled()
    expect(redis.state.events).toEqual(['ping'])
  })

  it('allows only one worker to run a duplicated leased job', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const state: RedisState = {
      leases: new Map(),
      queue: [],
      events: [],
    }
    const firstRedis = new FakeRedis([
      ['content-jobs', '23'],
      stopOnNextPop(firstController),
    ], state)
    const secondRedis = new FakeRedis([
      ['content-jobs', '23'],
      stopOnNextPop(secondController),
    ], state)
    let finishFirst!: () => void
    const firstRunning = new Promise<void>(resolve => {
      finishFirst = resolve
    })
    const firstRunner = vi.fn(() => firstRunning)
    const secondRunner = vi.fn()
    const { runContentWorker } = await import('./content-worker')
    const common = {
      queueName: 'content-jobs',
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(23)),
    }

    const first = runContentWorker({
      ...common,
      redis: firstRedis,
      signal: firstController.signal,
      resolveRunner: () => firstRunner,
    })
    await settle()
    const second = runContentWorker({
      ...common,
      redis: secondRedis,
      signal: secondController.signal,
      resolveRunner: () => secondRunner,
    })
    await second

    expect(firstRunner).toHaveBeenCalledOnce()
    expect(secondRunner).not.toHaveBeenCalled()
    expect(state.leases).toHaveProperty(
      'size',
      1,
    )

    finishFirst()
    await first

    expect(state.leases).toHaveProperty('size', 0)
    expect(state.events.filter(event => event.startsWith(
      'acquire:wms:content-job-lease:content-jobs:23:',
    ))).toHaveLength(2)
  })

  it('refreshes an owned lease and clears its timer before releasing it', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '31'],
      stopOnNextPop(controller),
    ])
    let finishRunner!: () => void
    const running = new Promise<void>(resolve => {
      finishRunner = resolve
    })
    const { runContentWorker } = await import('./content-worker')

    const worker = runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(31)),
      resolveRunner: () => () => running,
      leaseTtlMs: 90,
      leaseRefreshIntervalMs: 30,
    })
    await settle()
    await vi.advanceTimersByTimeAsync(30)

    expect(redis.state.events).toContain(
      'refresh:wms:content-job-lease:content-jobs:31:90',
    )

    finishRunner()
    await worker

    expect(redis.state.leases.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries lease refresh after one Redis transport error and clears its timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '33'],
      stopOnNextPop(controller),
    ])
    redis.refreshActions.push(new TypeError('Redis connection reset'))
    let finishRunner!: () => void
    const running = new Promise<void>(resolve => {
      finishRunner = resolve
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { runContentWorker } = await import('./content-worker')

    const worker = runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(33)),
      resolveRunner: () => () => running,
      leaseTtlMs: 100,
      leaseRefreshIntervalMs: 30,
    })
    await settle()
    await vi.advanceTimersByTimeAsync(60)

    expect(redis.state.events.filter(event => event.startsWith(
      'refresh:wms:content-job-lease:content-jobs:33:',
    ))).toHaveLength(2)
    expect(errorSpy).toHaveBeenCalledWith(
      'content job lease wms:content-job-lease:content-jobs:33 refresh failed',
      expect.any(TypeError),
    )
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('was lost'),
    )

    finishRunner()
    await worker

    expect(redis.state.leases.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['succeeded', 'cancelled', 'failed'])(
    'ignores terminal %s jobs after releasing their lease',
    async status => {
      const controller = new AbortController()
      const redis = new FakeRedis([
        ['content-jobs', '37'],
        stopOnNextPop(controller),
      ])
      const runner = vi.fn()
      const { runContentWorker } = await import('./content-worker')

      await runContentWorker({
        redis,
        queueName: 'content-jobs',
        signal: controller.signal,
        reconcile: vi.fn().mockResolvedValue({}),
        getJob: vi.fn().mockResolvedValue(durableJob(37, 'content', status)),
        resolveRunner: () => runner,
      })

      expect(runner).not.toHaveBeenCalled()
      expect(redis.state.leases.size).toBe(0)
    },
  )

  it.each([
    new ApiRequestError('temporary API failure', true),
    new JobFinalizationError('finalization acknowledgement lost'),
  ])(
    'releases the lease before enqueueing one retry for %s',
    async error => {
      const controller = new AbortController()
      const redis = new FakeRedis([
        ['content-jobs', '41'],
        stopOnNextPop(controller),
      ])
      const { runContentWorker } = await import('./content-worker')

      await runContentWorker({
        redis,
        queueName: 'content-jobs',
        signal: controller.signal,
        reconcile: vi.fn().mockResolvedValue({}),
        getJob: vi.fn().mockResolvedValue(durableJob(41)),
        resolveRunner: () => async () => {
          throw error
        },
      })

      expect(redis.state.queue).toEqual(['41'])
      const releaseIndex = redis.state.events.indexOf(
        'release:wms:content-job-lease:content-jobs:41',
      )
      const enqueueIndex = redis.state.events.indexOf(
        'enqueue:content-jobs:41',
      )
      expect(releaseIndex).toBeGreaterThan(-1)
      expect(enqueueIndex).toBeGreaterThan(releaseIndex)
    },
  )

  it('requeues a runner error that explicitly declares itself retryable', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '42'],
      stopOnNextPop(controller),
    ])
    const retryableProviderError = Object.assign(
      new Error('仙宫云实例启动超时'),
      { retryable: true },
    )
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(42)),
      resolveRunner: () => async () => {
        throw retryableProviderError
      },
    })

    expect(redis.state.queue).toEqual(['42'])
  })

  it('uses LPOS semantics to avoid adding a duplicate retry', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '43'],
      stopOnNextPop(controller),
    ])
    redis.state.queue.push('43')
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(43)),
      resolveRunner: () => async () => {
        throw new JobFinalizationError('response lost')
      },
    })

    expect(redis.state.queue).toEqual(['43'])
  })

  it('requeues a transport failure while loading the job before dispatch', async () => {
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '45'],
      stopOnNextPop(controller),
    ])
    const runner = vi.fn()
    const { runContentWorker } = await import('./content-worker')

    await runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
      resolveRunner: () => runner,
    })

    expect(runner).not.toHaveBeenCalled()
    expect(redis.state.queue).toEqual(['45'])
    expect(redis.state.events.filter(event => (
      event === 'enqueue:content-jobs:45'
    ))).toHaveLength(1)
  })

  it('does not requeue ordinary runner TypeErrors and leaves no refresh timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const redis = new FakeRedis([
      ['content-jobs', '47'],
      stopOnNextPop(controller),
    ])
    const { runContentWorker } = await import('./content-worker')

    const worker = runContentWorker({
      redis,
      queueName: 'content-jobs',
      signal: controller.signal,
      reconcile: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(durableJob(47)),
      resolveRunner: () => async () => {
        throw new TypeError('durable domain failure')
      },
    })
    await vi.runAllTimersAsync()
    await worker

    expect(redis.state.queue).toEqual([])
    expect(redis.state.leases.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('worker startup contracts', () => {
  it('posts to the protected reconciliation endpoint without a worker-selected queue', async () => {
    const previousToken = process.env.WORKER_TOKEN
    process.env.WORKER_TOKEN = 'worker-test-token'
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ enqueued: 0, job_ids: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { reconcileContentJobs } = await import('./content-worker')

    try {
      await reconcileContentJobs()
    } finally {
      if (previousToken === undefined) {
        delete process.env.WORKER_TOKEN
      } else {
        process.env.WORKER_TOKEN = previousToken
      }
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/jobs\/worker-reconcile$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Worker-Token': 'worker-test-token',
        }),
        body: undefined,
      }),
    )
  })

  it('atomically publishes and conditionally removes its exact ready payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wms-worker-ready-'))
    const readyFile = join(directory, 'worker.ready')
    const { createWorkerReadyFilePublisher } = await import('./content-worker')
    const publisher = createWorkerReadyFilePublisher({
      readyFile,
      marker: 'marker-123',
      configFingerprint: 'fingerprint-456',
    })

    try {
      await publisher.publish()

      expect(await readFile(readyFile, 'utf8')).toBe(
        'marker=marker-123\nconfig_fingerprint=fingerprint-456\n',
      )
      expect(await readdir(directory)).toEqual(['worker.ready'])

      await writeFile(readyFile, 'marker=new-owner\n', 'utf8')
      await publisher.cleanup()

      expect(await readFile(readyFile, 'utf8')).toBe('marker=new-owner\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { marker: '', configFingerprint: 'fingerprint' },
    { marker: 'marker', configFingerprint: '' },
  ])(
    'requires a marker and fingerprint when a ready file is configured',
    async identity => {
      const { createWorkerReadyFilePublisher } = await import('./content-worker')

      expect(() => createWorkerReadyFilePublisher({
        readyFile: '/tmp/worker.ready',
        ...identity,
      })).toThrow(/marker|fingerprint/i)
    },
  )
})
