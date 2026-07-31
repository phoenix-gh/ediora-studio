import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'

import {
  expect,
  test,
  type Page,
  type TestInfo,
} from '@playwright/test'
import Redis from 'ioredis'

import type { ContentJob } from '../lib/api/jobs'
import type { TextVideoProject } from '../lib/api/text-videos'
import { runContentWorker } from '../scripts/content-worker'
import {
  combineStartupAndCleanupErrors,
  createDeferredTtsLatch,
  E2E_REDIS_OWNER_LABEL,
  E2E_LLM_MODEL,
  E2E_PROVIDER_TOKEN,
  E2E_SPEECH_MODEL,
  E2E_TRANSCRIPTION_MODEL,
  E2E_VOICE_ID,
  resolveE2EPythonLaunch,
  resolveE2ERedisLaunch,
  startTextVideoProviderServer,
  terminateProvisionalProcessGroup,
  type DeferredTtsLatch,
  type E2ERedisLaunch,
  type TextVideoProviderServer,
} from './text-video-provider-server'


const REPOSITORY_ROOT = resolve(process.cwd(), '..')
const FRONTEND_ROOT = resolve(process.cwd())
const BACKEND_ROOT = join(REPOSITORY_ROOT, 'backend')
const OFFICIAL_MIMO_COMPLETION_URL =
  'https://api.xiaomimimo.com/v1/chat/completions'
const SCRIPT = '真实链路，让文字跟随声音。'
const SPLIT_TEXTS = ['真实链路，', '让文字跟随声音。'] as const
const EDITED_SEGMENT = '更新后的真实链路，'
const EDITED_SCRIPT = '更新后的真实链路，让文字跟随声音。'
const PROJECT_TITLE = 'Task 12 真实文字视频'
const PROCESS_LOG_LIMIT = 48 * 1024
const SERVICE_READY_TIMEOUT_MS = 45_000
const JOB_TIMEOUT_MS = 90_000
const SECRET_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'HEYGEN_API_KEY',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
  'MKFLOW_AGENT_API_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'REPLICATE_API_TOKEN',
  'WMS_IMAGE_API_KEY',
  'WMS_LLM_API_KEY',
  'WMS_SPEECH_API_KEY',
  'X_AUTH_TOKEN',
  'X_CT0',
  'ZAI_API_KEY',
] as const

type TerminalJob = ContentJob & {
  status: 'succeeded' | 'failed' | 'cancelled'
}

type ProcessName = 'redis' | 'api' | 'web'

type OwnedProcess = {
  name: ProcessName
  child: ChildProcessByStdio<null, Readable, Readable>
  pid: number
  marker: string
  startTicks: string
  output: BoundedOutput
}

type BrowserEvidence = {
  errors: string[]
  externalRequests: string[]
  nativeDialogs: string[]
}

type AudioProbe = {
  codec_name: string
  sample_rate: string
  channels: number
  bit_rate: string
}

class BoundedOutput {
  private value = ''

  append(chunk: Buffer | string) {
    this.value = `${this.value}${chunk.toString()}`
      .slice(-PROCESS_LOG_LIMIT)
  }

  read() {
    return this.value
  }
}

function timeout(ms: number): Promise<false> {
  return new Promise(resolve => {
    setTimeout(() => resolve(false), ms)
  })
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await new Promise(resolvePromise => {
      setTimeout(resolvePromise, 25)
    })
  }
  return false
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('failed to reserve a loopback port')
  }
  const port = address.port
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolvePromise()
    })
  })
  return port
}

async function executableAvailable(
  command: string,
  environment: NodeJS.ProcessEnv,
) {
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    try {
      await access(join(directory, command), fsConstants.X_OK)
      return true
    } catch {
      // Continue to the next explicit PATH entry.
    }
  }
  return false
}

async function processIdentity(pid: number) {
  try {
    const [stat, commandLine] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ])
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    return {
      startTicks: fields[19] ?? '',
      commandLine: commandLine.replaceAll('\0', ' ').trim(),
    }
  } catch {
    return null
  }
}

async function waitUntil(
  description: string,
  predicate: () => Promise<boolean>,
  {
    timeoutMs = SERVICE_READY_TIMEOUT_MS,
    intervalMs = 100,
    process,
  }: {
    timeoutMs?: number
    intervalMs?: number
    process?: OwnedProcess
  } = {},
) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (
      process
      && process.child.exitCode !== null
    ) {
      throw new Error(
        `${description}: ${process.name} exited with `
        + `${process.child.exitCode}\n${process.output.read()}`,
      )
    }
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => {
      setTimeout(resolvePromise, intervalMs)
    })
  }
  throw new Error(
    `timed out waiting for ${description}`
    + `${lastError instanceof Error ? `: ${lastError.message}` : ''}`
    + `${process ? `\n${process.output.read()}` : ''}`,
  )
}

async function redisPing(port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = new Socket()
    let response = ''
    const finish = (result: boolean) => {
      socket.destroy()
      resolvePromise(result)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, '127.0.0.1', () => {
      socket.write('*1\r\n$4\r\nPING\r\n')
    })
    socket.on('data', chunk => {
      response += chunk.toString()
      if (response.includes('+PONG')) finish(true)
    })
  })
}

async function collectFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(path)
    }
  }
  await visit(root)
  return result.sort()
}

function isolatedEnvironment(values: Record<string, string>) {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const name of SECRET_ENV_NAMES) environment[name] = ''
  return Object.assign(environment, values)
}

function terminal(status: string): status is TerminalJob['status'] {
  return ['succeeded', 'failed', 'cancelled'].includes(status)
}

class TextVideoHarness {
  readonly tempRoot: string
  readonly uploadsRoot: string
  readonly sessionsRoot: string
  readonly redisPort: number
  readonly apiPort: number
  readonly webPort: number
  readonly redisUrl: string
  readonly apiOrigin: string
  readonly apiBase: string
  readonly webOrigin: string
  readonly queueName: string
  readonly workerToken: string
  readonly provider: TextVideoProviderServer
  readonly redisLaunch: E2ERedisLaunch
  readonly speechSourceUrls: string[] = []
  readonly cleanupErrors: string[] = []

  private readonly environment: NodeJS.ProcessEnv
  private readonly previousEnvironment = new Map<string, string | undefined>()
  private readonly processes: OwnedProcess[] = []
  private workerRedis: Redis | null = null
  private workerAbort: AbortController | null = null
  private workerPromise: Promise<void> | null = null
  private readonly ttsLatch?: DeferredTtsLatch
  private closed = false

  private constructor(input: {
    tempRoot: string
    redisPort: number
    apiPort: number
    webPort: number
    provider: TextVideoProviderServer
    redisLaunch: E2ERedisLaunch
    ttsLatch?: DeferredTtsLatch
  }) {
    this.tempRoot = input.tempRoot
    this.uploadsRoot = join(this.tempRoot, 'uploads')
    this.sessionsRoot = join(this.tempRoot, 'sessions')
    this.redisPort = input.redisPort
    this.apiPort = input.apiPort
    this.webPort = input.webPort
    this.redisUrl = `redis://127.0.0.1:${this.redisPort}/0`
    this.apiOrigin = `http://127.0.0.1:${this.apiPort}`
    this.apiBase = `${this.apiOrigin}/api`
    this.webOrigin = `http://127.0.0.1:${this.webPort}`
    this.queueName = `content-jobs:e2e:${randomBytes(12).toString('hex')}`
    this.workerToken = `task12-worker-${randomBytes(24).toString('hex')}`
    this.provider = input.provider
    this.redisLaunch = input.redisLaunch
    this.ttsLatch = input.ttsLatch
    this.environment = isolatedEnvironment({
      WMS_DATABASE_URL: `sqlite+aiosqlite:///${join(
        this.tempRoot,
        'text-video-e2e.sqlite3',
      )}`,
      WMS_UPLOADS_DIR: this.uploadsRoot,
      WMS_REDIS_URL: this.redisUrl,
      WMS_WORKER_QUEUE: this.queueName,
      WMS_API_URL: this.apiBase,
      NEXT_PUBLIC_API_URL: this.apiBase,
      WMS_PLAYWRIGHT_BASE_URL: this.webOrigin,
      WMS_CORS_ORIGINS: this.webOrigin,
      WMS_DISABLE_SCHEDULER: '1',
      FEEDGRAB_DATA_DIR: this.sessionsRoot,
      WMS_WORKER_TOKEN: this.workerToken,
      NEXT_TELEMETRY_DISABLED: '1',
      PYTHONUNBUFFERED: '1',
    })
  }

  static async start({
    ttsLatch,
  }: {
    ttsLatch?: DeferredTtsLatch
  } = {}): Promise<TextVideoHarness> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'wms-text-video-e2e-'))
    const [redisPort, apiPort, webPort] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ])
    const provider = await startTextVideoProviderServer({ ttsLatch })
    const containerName = `wms-text-video-e2e-redis-${
      randomBytes(10).toString('hex')
    }`
    const ownerLabel = randomBytes(18).toString('hex')
    const launchEnvironment = isolatedEnvironment({})
    const redisLaunch = resolveE2ERedisLaunch({
      nativeAvailable: await executableAvailable(
        'redis-server',
        launchEnvironment,
      ),
      port: redisPort,
      dataDirectory: join(tempRoot, 'redis'),
      containerName,
      ownerLabel,
    })
    const harness = new TextVideoHarness({
      tempRoot,
      redisPort,
      apiPort,
      webPort,
      provider,
      redisLaunch,
      ttsLatch,
    })
    try {
      await harness.startServices()
      return harness
    } catch (error) {
      await harness.close()
      throw combineStartupAndCleanupErrors(
        error,
        harness.cleanupErrors,
      )
    }
  }

  private applyProcessEnvironment() {
    const names = new Set([
      ...Object.keys(this.environment),
      ...SECRET_ENV_NAMES,
    ])
    for (const name of names) {
      this.previousEnvironment.set(name, process.env[name])
    }
    for (const name of SECRET_ENV_NAMES) process.env[name] = ''
    for (const [name, value] of Object.entries(this.environment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  private restoreProcessEnvironment() {
    for (const [name, value] of this.previousEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    this.previousEnvironment.clear()
  }

  private async spawnOwned(
    name: ProcessName,
    command: string,
    args: string[],
    cwd: string,
    marker: string,
    { viaSetsid = false }: { viaSetsid?: boolean } = {},
  ) {
    const child = spawn(
      viaSetsid ? 'setsid' : command,
      viaSetsid ? [command, ...args] : args,
      {
      cwd,
      env: this.environment,
      detached: !viaSetsid,
      stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const output = new BoundedOutput()
    child.stdout.on('data', chunk => output.append(chunk))
    child.stderr.on('data', chunk => output.append(chunk))
    await new Promise<void>((resolvePromise, reject) => {
      child.once('spawn', resolvePromise)
      child.once('error', reject)
    })
    if (!child.pid) throw new Error(`${name} did not expose a PID`)
    let identity: Awaited<ReturnType<typeof processIdentity>> = null
    const identityDeadline = Date.now() + 2_000
    while (Date.now() < identityDeadline) {
      identity = await processIdentity(child.pid)
      if (
        identity?.commandLine.includes(marker)
        || child.exitCode !== null
      ) break
      await new Promise(resolvePromise => {
        setTimeout(resolvePromise, 25)
      })
    }
    if (!identity || !identity.commandLine.includes(marker)) {
      const stopped = await terminateProvisionalProcessGroup({
        pid: child.pid,
        waitForExit: () => waitForProcessGroupExit(child.pid!, 1_000),
      })
      throw new Error(
        `${name} PID identity is missing marker ${marker}: `
        + `${identity?.commandLine ?? 'process exited'}`
        + `${stopped ? '' : '; process group did not stop'}`,
      )
    }
    const owned: OwnedProcess = {
      name,
      child,
      pid: child.pid,
      marker,
      startTicks: identity.startTicks,
      output,
    }
    this.processes.push(owned)
    return owned
  }

  private async startServices() {
    await Promise.all([
      mkdir(this.uploadsRoot, { recursive: true }),
      mkdir(this.sessionsRoot, { recursive: true }),
      mkdir(join(this.tempRoot, 'redis'), { recursive: true }),
    ])
    this.applyProcessEnvironment()

    const redis = await this.spawnOwned(
      'redis',
      this.redisLaunch.command,
      this.redisLaunch.args,
      this.tempRoot,
      this.redisLaunch.marker,
    )
    await waitUntil(
      'isolated Redis PONG',
      () => redisPing(this.redisPort),
      { process: redis },
    )

    const python = resolveE2EPythonLaunch({
      WMS_E2E_PYTHON: this.environment.WMS_E2E_PYTHON,
      WMS_CONDA_ENV: this.environment.WMS_CONDA_ENV,
    })
    const api = await this.spawnOwned(
      'api',
      python.command,
      [
        ...python.args,
        '-m', 'uvicorn',
        'main:app',
        '--host', '127.0.0.1',
        '--port', String(this.apiPort),
      ],
      BACKEND_ROOT,
      String(this.apiPort),
      { viaSetsid: python.command === 'conda' },
    )
    await waitUntil(
      'isolated FastAPI /health',
      async () => {
        const response = await fetch(`${this.apiOrigin}/health`)
        return response.ok
      },
      { process: api },
    )
    await this.configureProviders()
    await this.startWorker()

    const web = await this.spawnOwned(
      'web',
      'pnpm',
      [
        'exec', 'next', 'dev',
        '--hostname', '127.0.0.1',
        '--port', String(this.webPort),
      ],
      FRONTEND_ROOT,
      String(this.webPort),
    )
    await waitUntil(
      'isolated Next text-video route',
      async () => {
        const response = await fetch(`${this.webOrigin}/text-video`)
        return response.ok
      },
      { process: web, timeoutMs: 60_000, intervalMs: 250 },
    )
  }

  private async configureProviders() {
    const response = await fetch(`${this.apiBase}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm_provider: 'custom',
        llm_model: E2E_LLM_MODEL,
        llm_api_key: E2E_PROVIDER_TOKEN,
        llm_base_url: this.provider.baseUrl,
        speech_provider: 'mimo',
        speech_model: E2E_SPEECH_MODEL,
        speech_base_url: 'https://api.xiaomimimo.com/v1',
        speech_api_key: E2E_PROVIDER_TOKEN,
        speech_default_voice: E2E_VOICE_ID,
        transcription_provider: 'openai-compatible',
        transcription_model: E2E_TRANSCRIPTION_MODEL,
        transcription_base_url: this.provider.baseUrl,
        transcription_api_key: E2E_PROVIDER_TOKEN,
        transcription_max_duration_seconds: 60,
        transcription_max_audio_bytes: 2 * 1024 * 1024,
      }),
    })
    if (!response.ok) {
      throw new Error(
        `provider settings failed (${response.status}): `
        + `${await response.text()}`,
      )
    }
    const settings = await response.json() as {
      llm_model: string
      speech_model: string
      speech_base_url: string
      transcription_model: string
    }
    expect(settings).toMatchObject({
      llm_model: E2E_LLM_MODEL,
      speech_model: E2E_SPEECH_MODEL,
      speech_base_url: 'https://api.xiaomimimo.com/v1',
      transcription_model: E2E_TRANSCRIPTION_MODEL,
    })
  }

  private speechFetch(): typeof fetch {
    return async (input, init) => {
      const sourceUrl = input instanceof Request
        ? input.url
        : input.toString()
      this.speechSourceUrls.push(sourceUrl)
      if (sourceUrl !== OFFICIAL_MIMO_COMPLETION_URL) {
        throw new Error(`unexpected MiMo source URL: ${sourceUrl}`)
      }
      if (
        input instanceof Request
        || init?.method !== 'POST'
        || typeof init.body !== 'string'
      ) {
        throw new Error('unexpected MiMo fetch shape')
      }
      const headers = new Headers(init.headers)
      if (
        headers.get('authorization') !== `Bearer ${E2E_PROVIDER_TOKEN}`
        || headers.get('content-type') !== 'application/json'
      ) {
        throw new Error('unexpected MiMo dummy authorization or content type')
      }
      return fetch(`${this.provider.baseUrl}/chat/completions`, {
        ...init,
        redirect: 'error',
      })
    }
  }

  private async startWorker() {
    this.workerRedis = new Redis(this.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: null,
    })
    this.workerRedis.on('error', () => undefined)
    await this.workerRedis.connect()
    this.workerAbort = new AbortController()
    let ready!: () => void
    const readyPromise = new Promise<void>(resolvePromise => {
      ready = resolvePromise
    })
    this.workerPromise = runContentWorker({
      redis: this.workerRedis,
      queueName: this.queueName,
      signal: this.workerAbort.signal,
      speechFetch: this.speechFetch(),
      onReady: ready,
    })
    await Promise.race([
      readyPromise,
      this.workerPromise.then(() => {
        throw new Error('content worker exited before readiness')
      }),
    ])
  }

  async apiJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, init)
    if (!response.ok) {
      throw new Error(
        `${init?.method ?? 'GET'} ${path} failed (${response.status}): `
        + `${await response.text()}`,
      )
    }
    return response.json() as Promise<T>
  }

  async waitForProject(
    projectId: number,
    description: string,
    predicate: (project: TextVideoProject) => boolean,
  ): Promise<TextVideoProject> {
    let latest: TextVideoProject | null = null
    await waitUntil(
      description,
      async () => {
        latest = await this.apiJson<TextVideoProject>(
          `/text-videos/${projectId}`,
        )
        return predicate(latest)
      },
      { timeoutMs: JOB_TIMEOUT_MS, intervalMs: 150 },
    )
    if (!latest) throw new Error(`${description}: no project document`)
    return latest
  }

  async waitForTerminalJob(jobId: number): Promise<TerminalJob> {
    await waitUntil(
      `terminal job ${jobId}`,
      async () => {
        const current = await this.apiJson<ContentJob>(`/jobs/${jobId}`)
        return terminal(current.status)
      },
      { timeoutMs: JOB_TIMEOUT_MS, intervalMs: 150 },
    )
    const latest = await this.apiJson<ContentJob>(`/jobs/${jobId}`)
    if (!terminal(latest.status)) {
      throw new Error(`job ${jobId} did not become terminal`)
    }
    return latest as TerminalJob
  }

  async probeAudioUrl(url: string, label: string): Promise<AudioProbe> {
    const resolvedUrl = new URL(url, this.apiOrigin)
    expect(resolvedUrl.origin).toBe(this.apiOrigin)
    expect(resolvedUrl.origin).not.toBe(this.webOrigin)
    const response = await fetch(resolvedUrl)
    expect(response.status, `${label} media status`).toBe(200)
    expect(response.headers.get('content-type')).toContain('audio/mpeg')
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.byteLength).toBeGreaterThan(1_000)
    const path = join(
      this.tempRoot,
      `probe-${label.replaceAll(/[^a-z0-9-]/giu, '-')}.mp3`,
    )
    await writeFile(path, bytes)
    const result = await runCommand(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries',
        'stream=codec_name,sample_rate,channels,bit_rate',
        '-of', 'json',
        path,
      ],
      this.tempRoot,
    )
    const parsed = JSON.parse(result) as { streams?: AudioProbe[] }
    const stream = parsed.streams?.[0]
    if (!stream) throw new Error(`${label} has no ffprobe audio stream`)
    expect(stream.codec_name).toBe('mp3')
    expect(Number(stream.sample_rate)).toBe(44_100)
    expect(stream.channels).toBe(1)
    expect(Math.abs(Number(stream.bit_rate) - 128_000)).toBeLessThanOrEqual(
      2_000,
    )
    return stream
  }

  diagnostics() {
    return {
      tempRoot: this.tempRoot,
      queueName: this.queueName,
      providerCalls: this.provider.callCounts,
      providerRequests: this.provider.requestSummaries,
      speechSourceUrls: this.speechSourceUrls,
      cleanupErrors: this.cleanupErrors,
      redisRuntime: {
        mode: this.redisLaunch.mode,
        containerName: this.redisLaunch.containerName ?? null,
      },
      processes: Object.fromEntries(this.processes.map(process => [
        process.name,
        {
          exitCode: process.child.exitCode,
          output: process.output.read(),
        },
      ])),
    }
  }

  async attachDiagnostics(testInfo: TestInfo) {
    await testInfo.attach('text-video-runtime.json', {
      body: Buffer.from(JSON.stringify(this.diagnostics(), null, 2)),
      contentType: 'application/json',
    })
  }

  private async stopOwned(process: OwnedProcess) {
    let firstWaitMs = 5_000
    if (process.child.exitCode !== null) {
      if (await waitForProcessGroupExit(process.pid, 250)) return
      firstWaitMs = 1_000
    } else {
      const identity = await processIdentity(process.pid)
      if (
        !identity
        || identity.startTicks !== process.startTicks
        || !identity.commandLine.includes(process.marker)
      ) {
        this.cleanupErrors.push(
          `refused to signal ${process.name}: PID identity changed`,
        )
        return
      }
    }
    let waitAttempt = 0
    const stopped = await terminateProvisionalProcessGroup({
      pid: process.pid,
      waitForExit: () => {
        waitAttempt += 1
        return waitForProcessGroupExit(
          process.pid,
          waitAttempt === 1 ? firstWaitMs : 2_000,
        )
      },
    })
    if (!stopped) {
      this.cleanupErrors.push(
        `${process.name} process group did not stop`,
      )
    }
  }

  private async cleanupStep(
    label: string,
    operation: () => Promise<void>,
  ) {
    try {
      await operation()
    } catch (error) {
      this.cleanupErrors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async removeOwnedRedisContainer() {
    if (
      this.redisLaunch.mode !== 'docker'
      || !this.redisLaunch.containerName
      || !this.redisLaunch.ownerLabel
    ) return
    const name = this.redisLaunch.containerName
    const inspect = await runCommandResult(
      'docker',
      [
        'inspect',
        '--format',
        `{{ index .Config.Labels "${E2E_REDIS_OWNER_LABEL}" }}`,
        name,
      ],
      this.tempRoot,
    )
    if (inspect.exitCode !== 0) {
      if (/no such (?:object|container)/iu.test(
        `${inspect.stderr}\n${inspect.stdout}`,
      )) return
      this.cleanupErrors.push(
        `failed to inspect Redis container ${name}: `
        + `${inspect.stderr || inspect.stdout}`,
      )
      return
    }
    if (inspect.stdout.trim() !== this.redisLaunch.ownerLabel) {
      this.cleanupErrors.push(
        `refused to remove Redis container ${name}: owner label changed`,
      )
      return
    }
    const removal = await runCommandResult(
      'docker',
      ['rm', '--force', name],
      this.tempRoot,
    )
    if (removal.exitCode !== 0) {
      this.cleanupErrors.push(
        `failed to remove owned Redis container ${name}: `
        + `${removal.stderr || removal.stdout}`,
      )
      return
    }
    const confirmation = await runCommandResult(
      'docker',
      ['inspect', name],
      this.tempRoot,
    )
    if (
      confirmation.exitCode === 0
      || !/no such (?:object|container)/iu.test(
        `${confirmation.stderr}\n${confirmation.stdout}`,
      )
    ) {
      this.cleanupErrors.push(
        `could not confirm Redis container ${name} was removed: `
        + `${confirmation.stderr || confirmation.stdout}`,
      )
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const byName = new Map(this.processes.map(process => [
      process.name,
      process,
    ]))
    const web = byName.get('web')
    if (web) {
      await this.cleanupStep('stop web', () => this.stopOwned(web))
    }

    this.workerAbort?.abort()
    this.ttsLatch?.release()
    if (this.workerPromise) {
      await this.cleanupStep('stop worker', async () => {
        const workerDone = await Promise.race([
          this.workerPromise!.then(() => true, error => {
            throw error
          }),
          timeout(5_000),
        ])
        if (!workerDone) {
          throw new Error('worker did not stop within 5 seconds')
        }
      })
    }
    this.workerRedis?.disconnect()

    const api = byName.get('api')
    if (api) {
      await this.cleanupStep('stop API', () => this.stopOwned(api))
    }
    await this.cleanupStep(
      'remove Redis container',
      () => this.removeOwnedRedisContainer(),
    )
    const redis = byName.get('redis')
    if (redis) {
      await this.cleanupStep('stop Redis', () => this.stopOwned(redis))
    }
    await this.cleanupStep('stop provider', () => this.provider.close())

    this.restoreProcessEnvironment()
    const parent = resolve(this.tempRoot, '..')
    if (
      parent !== resolve(tmpdir())
      || !basename(this.tempRoot).startsWith('wms-text-video-e2e-')
    ) {
      this.cleanupErrors.push(
        `refused to delete unexpected temp root ${this.tempRoot}`,
      )
    } else {
      await this.cleanupStep('remove temp root', () => rm(
        this.tempRoot,
        { recursive: true, force: true },
      ))
    }
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await runCommandResult(command, args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} exited ${result.exitCode}\n`
      + `${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout
}

async function runCommandResult(
  command: string,
  args: string[],
  cwd: string,
) {
  const child = spawn(command, args, {
    cwd,
    env: isolatedEnvironment({}),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout = `${stdout}${chunk.toString()}`.slice(-PROCESS_LOG_LIMIT)
  })
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString()}`.slice(-PROCESS_LOG_LIMIT)
  })
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code ?? -1))
  })
  return { exitCode, stdout, stderr }
}

function attachBrowserEvidence(
  page: Page,
  harness: TextVideoHarness,
): BrowserEvidence {
  const evidence: BrowserEvidence = {
    errors: [],
    externalRequests: [],
    nativeDialogs: [],
  }
  page.on('console', message => {
    if (message.type() === 'error') {
      evidence.errors.push(`console: ${message.text()}`)
    }
  })
  page.on('pageerror', error => {
    evidence.errors.push(`pageerror: ${error.message}`)
  })
  page.on('dialog', dialog => {
    evidence.nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void dialog.dismiss()
  })
  page.on('request', request => {
    let url: URL
    try {
      url = new URL(request.url())
    } catch {
      return
    }
    if (
      ['http:', 'https:'].includes(url.protocol)
      && ![harness.webOrigin, harness.apiOrigin].includes(url.origin)
    ) {
      evidence.externalRequests.push(
        `${request.method()} ${request.url()}`,
      )
    }
  })
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText ?? 'unknown'
    const url = new URL(request.url())
    const expectedClientAbort = (
      request.method() === 'GET'
      && request.resourceType() === 'media'
      && url.origin === harness.apiOrigin
      && failure === 'net::ERR_ABORTED'
    )
    const expectedNavigationAbort = (
      request.isNavigationRequest()
      && failure === 'net::ERR_ABORTED'
    )
    if (!expectedClientAbort && !expectedNavigationAbort) {
      evidence.errors.push(
        `requestfailed: ${request.method()} ${request.url()} (${failure})`,
      )
    }
  })
  page.on('response', response => {
    if (response.status() >= 400) {
      evidence.errors.push(
        `http ${response.status()}: `
        + `${response.request().method()} ${response.url()}`,
      )
    }
  })
  return evidence
}

async function initializeSaveObservation(page: Page) {
  await page.getByTestId('text-video-save-status').evaluate(element => {
    const target = window as typeof window & {
      __textVideoSaveStates?: string[]
    }
    target.__textVideoSaveStates = [element.textContent?.trim() ?? '']
    const observer = new MutationObserver(() => {
      target.__textVideoSaveStates?.push(
        element.textContent?.trim() ?? '',
      )
    })
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
}

async function observedSaveStates(page: Page) {
  return page.evaluate(() => (
    (window as typeof window & {
      __textVideoSaveStates?: string[]
    }).__textVideoSaveStates ?? []
  ))
}

async function waitForSaved(page: Page) {
  await expect(
    page.getByTestId('text-video-save-status'),
  ).toContainText('已保存', { timeout: 20_000 })
}

async function savePlatformTemplateDefault(
  page: Page,
  harness: TextVideoHarness,
) {
  await page.goto(`${harness.webOrigin}/settings`)
  await page.getByLabel('设置导航')
    .getByRole('button', { name: /文字视频/u })
    .click()

  await page.getByRole('textbox', { name: '品牌标题' })
    .fill('CHANNEL DEFAULT')
  const saveResponse = page.waitForResponse(response => (
    response.url() === `${harness.apiBase}/settings`
    && response.request().method() === 'PUT'
  ))
  await page.getByRole('button', { name: '保存模板默认值' }).click()
  expect((await saveResponse).status()).toBe(200)
  await expect(page.getByText('文字视频模板默认视觉已保存'))
    .toBeVisible()

  const settings = await harness.apiJson<{
    text_video_template_defaults: Record<
      string,
      Record<string, unknown>
    >
  }>('/settings')
  expect(settings.text_video_template_defaults['tech-text-v1@1'])
    .toMatchObject({ brandTitle: 'CHANNEL DEFAULT' })
}

async function createAndEditProject(
  page: Page,
  harness: TextVideoHarness,
  script = SCRIPT,
) {
  await page.goto(`${harness.webOrigin}/text-video`)
  const creation = page.waitForResponse(response => (
    response.url() === `${harness.apiBase}/text-videos`
    && response.request().method() === 'POST'
  ))
  await page.getByLabel('页面操作')
    .getByRole('button', { name: '新建文字视频' })
    .click()
  const createdResponse = await creation
  expect(createdResponse.status()).toBe(201)
  const created = await createdResponse.json() as TextVideoProject
  await expect(page).toHaveURL(
    `${harness.webOrigin}/text-video/${created.id}`,
  )
  await initializeSaveObservation(page)
  await page.getByRole('textbox', { name: '作品标题' }).fill(PROJECT_TITLE)
  await page.locator('#text-video-script').fill(script)
  await expect(
    page.getByTestId('text-video-save-status'),
  ).toContainText('有未保存更改')
  await waitForSaved(page)
  const saveStates = await observedSaveStates(page)
  expect(saveStates).toEqual(expect.arrayContaining([
    '有未保存更改',
    '正在保存',
    '已保存',
  ]))
  return harness.waitForProject(
    created.id,
    'saved title and script',
    project => (
      project.title === PROJECT_TITLE
      && project.script === script
    ),
  )
}

async function clickAndReadLaunch(
  page: Page,
  matcher: (url: URL) => boolean,
  action: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url())
    return response.request().method() === 'POST' && matcher(url)
  })
  await action()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  return response.json() as Promise<{
    jobs: Array<{ id: number; flow: string; target_id: number | string }>
    project: TextVideoProject
  }>
}

async function applyTwoSegmentAiSplit(
  page: Page,
  harness: TextVideoHarness,
  saved: TextVideoProject,
) {
  const response = await clickAndReadLaunch(
    page,
    url => url.pathname.endsWith(
      `/text-videos/${saved.id}/speech-split-preview`,
    ),
    async () => {
      await page.getByRole('button', { name: 'AI 自动分段' }).click()
    },
  )
  expect(response.jobs).toHaveLength(1)
  expect(response.jobs[0].flow).toBe('text_video_split_preview')
  const job = await harness.waitForTerminalJob(response.jobs[0].id)
  expect(job.status).toBe('succeeded')
  expect(job.steps).toEqual([
    expect.objectContaining({
      key: 'propose_boundaries',
      status: 'succeeded',
      output: expect.objectContaining({
        speech_split_mode: 'auto',
        segments: SPLIT_TEXTS.map(text => expect.objectContaining({ text })),
      }),
    }),
  ])
  const dialog = page.getByRole('dialog', {
    name: 'AI 口播分段预览',
  })
  await expect(dialog).toBeVisible()
  const apply = dialog.getByRole('button', { name: '应用分段' })
  await expect(apply).toBeEnabled({ timeout: 20_000 })
  await apply.click()
  await expect(dialog).toBeHidden()
  await waitForSaved(page)
  const split = await harness.waitForProject(
    saved.id,
    'applied two exact split segments',
    project => (
      project.speech_split_mode === 'auto'
      && project.paragraphs.length === SPLIT_TEXTS.length
      && project.paragraphs.every(
        (segment, index) => segment.text === SPLIT_TEXTS[index],
      )
    ),
  )
  expect(split.paragraphs.map(segment => segment.id)).toEqual([
    expect.stringMatching(/^segment-[a-f0-9]{12}-1$/u),
    expect.stringMatching(/^segment-[a-f0-9]{12}-2$/u),
  ])
  expect(split.paragraphs.map(segment => segment.text).join('')).toBe(SCRIPT)
  return split
}

async function assertNoSyntheticUi(
  page: Page,
  evidence: BrowserEvidence,
) {
  expect(evidence.nativeDialogs).toEqual([])
  await expect(page.locator('[data-slot="drawer-content"]')).toHaveCount(0)
  await expect(page.getByText(/演示波形|模拟波形|Fake waveform/iu))
    .toHaveCount(0)
  const mp4 = page.getByRole('button', { name: 'MP4 渲染暂未开放' })
  if (await mp4.count()) await expect(mp4).toBeDisabled()
  await expect(
    page.getByRole('button', { name: /MP4/iu }).and(
      page.locator(':not([disabled])'),
    ),
  ).toHaveCount(0)
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test('real text-video workflow persists from desktop to compact UI', async ({
  page,
}, testInfo) => {
  const harness = await TextVideoHarness.start()
  const evidence = attachBrowserEvidence(page, harness)
  try {
    await page.setViewportSize({ width: 1440, height: 960 })
    await savePlatformTemplateDefault(page, harness)
    const saved = await createAndEditProject(page, harness)
    expect(saved.paragraphs).toHaveLength(1)
    expect(saved.speech_split_mode).toBe('single')
    expect(saved.render_input.templateProps).toMatchObject({
      brandTitle: 'CHANNEL DEFAULT',
      showSceneNumber: true,
    })

    const splitProject = await applyTwoSegmentAiSplit(page, harness, saved)
    const stableSegmentIds = splitProject.paragraphs.map(segment => segment.id)

    await page.getByRole('tab', { name: '配音制作' }).click()
    await waitForSaved(page)
    const speechLaunch = await clickAndReadLaunch(
      page,
      url => url.pathname.endsWith(
        `/text-videos/${saved.id}/speech-segments/generate-pending`,
      ),
      async () => {
        await page.getByRole('button', {
          name: '生成全部未生成段落',
        }).click()
      },
    )
    expect(speechLaunch.jobs).toHaveLength(2)
    expect(speechLaunch.jobs.map(job => job.flow)).toEqual([
      'text_video_speech',
      'text_video_speech',
    ])
    expect(speechLaunch.jobs.map(job => job.target_id)).toEqual(
      stableSegmentIds,
    )
    const speechJobs = await Promise.all(
      speechLaunch.jobs.map(job => harness.waitForTerminalJob(job.id)),
    )
    speechJobs.forEach(job => {
      expect(job.status).toBe('succeeded')
      expect(job.steps).toEqual([
        expect.objectContaining({
          key: 'generate_speech',
          status: 'succeeded',
        }),
      ])
    })
    const speechReady = await harness.waitForProject(
      saved.id,
      'two ready speech segments',
      project => (
        project.paragraphs.length === 2
        && project.paragraphs.every(segment => segment.status === 'ready')
      ),
    )
    for (const [index, segment] of speechReady.paragraphs.entries()) {
      const card = page.getByTestId('speech-segment-card').filter({
        hasText: segment.text,
      })
      await card.click()
      await expect(page.getByTestId('segment-audio')).toBeVisible({
        timeout: 20_000,
      })
      const speechSrc = await page.getByTestId('segment-audio')
        .getAttribute('src')
      expect(speechSrc).toBeTruthy()
      expect(new URL(speechSrc!).origin).toBe(harness.apiOrigin)
      await harness.probeAudioUrl(segment.audio_url, `speech-${index + 1}`)
      await page.getByRole('button', { name: '确认当前段' }).click()
      await harness.waitForProject(
        saved.id,
        `confirmed speech segment ${index + 1}`,
        project => project.paragraphs[index]?.status === 'confirmed',
      )
    }
    const confirmed = await harness.waitForProject(
      saved.id,
      'all speech segments confirmed',
      project => project.paragraphs.every(
        segment => segment.status === 'confirmed',
      ),
    )
    expect(confirmed.paragraphs.map(segment => ({
      id: segment.id,
      text: segment.text,
      status: segment.status,
    }))).toEqual(splitProject.paragraphs.map(segment => ({
      id: segment.id,
      text: segment.text,
      status: 'confirmed',
    })))

    const masterLaunch = await clickAndReadLaunch(
      page,
      url => url.pathname.endsWith(
        `/text-videos/${saved.id}/master-audio/build`,
      ),
      async () => {
        await page.getByRole('button', { name: '生成主音频' }).click()
      },
    )
    expect(masterLaunch.jobs).toHaveLength(1)
    expect(masterLaunch.jobs[0].flow).toBe('text_video_master_audio')
    const masterJob = await harness.waitForTerminalJob(
      masterLaunch.jobs[0].id,
    )
    expect(masterJob.status).toBe('succeeded')
    expect(masterJob.steps.map(step => [step.key, step.status])).toEqual([
      ['assemble_master_audio', 'succeeded'],
      ['align_master_timeline', 'succeeded'],
    ])
    const timelineReady = await harness.waitForProject(
      saved.id,
      'ready master timeline',
      project => (
        project.master_audio.status === 'ready'
        && project.master_audio.timeline_status === 'ready'
        && project.master_audio.word_timings.length > 0
      ),
    )
    await expect(page.getByTestId('master-audio-status')).toContainText(
      '时间轴已就绪',
      { timeout: 20_000 },
    )
    await expect(page.getByTestId('master-audio')).toBeVisible()
    const masterSrc = await page.getByTestId('master-audio')
      .getAttribute('src')
    expect(masterSrc).toBeTruthy()
    expect(new URL(masterSrc!).origin).toBe(harness.apiOrigin)
    await harness.probeAudioUrl(
      timelineReady.master_audio.audio_url,
      'master',
    )
    expect(timelineReady.master_audio).toMatchObject({
      sample_rate: 44_100,
      sample_count: 88_200,
      timeline_source: 'forced-alignment',
    })
    expect(timelineReady.master_audio.duration).toBe(2)
    expect(timelineReady.master_audio.word_timings[0].start).toBe(0)
    expect(
      timelineReady.master_audio.word_timings.at(-1)?.end,
    ).toBe(2)

    await page.getByRole('tab', { name: '视频合成' }).click()
    await waitForSaved(page)
    await page.getByRole('button', { name: 'AI 生成分镜' }).click()
    const sceneDialog = page.getByRole('dialog', { name: 'AI 画面导演' })
    await expect(sceneDialog).toBeVisible()
    await expect(
      sceneDialog.getByRole('radio', { name: '调整全部场景' }),
    ).toBeChecked()
    const sceneResponsePromise = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && response.url().endsWith(
        `/text-videos/${saved.id}/scene-plan/generate`,
      )
    ))
    await sceneDialog.getByRole('button', {
      name: '让 AI 调整画面',
    }).click()
    const sceneResponse = await sceneResponsePromise
    expect(sceneResponse.status()).toBe(201)
    const sceneLaunch = await sceneResponse.json() as {
      jobs: Array<{ id: number; flow: string }>
    }
    expect(sceneLaunch.jobs).toHaveLength(1)
    const sceneJob = await harness.waitForTerminalJob(
      sceneLaunch.jobs[0].id,
    )
    expect(sceneJob.status).toBe('succeeded')
    await expect(sceneDialog).toBeHidden({ timeout: 20_000 })
    const sceneReady = await harness.waitForProject(
      saved.id,
      'ready scene and render projection',
      project => (
        project.scene_plan.status === 'ready'
        && project.render_input.segments.length === 1
      ),
    )
    await expect(page.getByTestId('remotion-preview')).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      page.getByTestId('remotion-preview').locator('.__remotion-player'),
    ).toHaveCount(1)
    const preview = page.getByTestId('remotion-preview')
    await expect(preview).toContainText('CHANNEL DEFAULT / 述策')
    await expect(preview).not.toContainText('WEMEDIA')
    expect(sceneReady.scene_plan.scenes).toHaveLength(1)
    expect(sceneReady.scene_plan.scenes[0]).toMatchObject({
      fromWordId: sceneReady.master_audio.word_timings[0].id,
      throughWordId: sceneReady.master_audio.word_timings.at(-1)?.id,
      animation: 'fade-up',
    })
    expect(sceneReady.render_input).toMatchObject({
      templateId: 'tech-text-v1',
      templateVersion: 1,
      audio: sceneReady.master_audio.audio_url,
      segments: [expect.objectContaining({
        start: 0,
        end: 2,
        animation: 'fade-up',
      })],
    })
    expect(sceneReady.render_input.segments[0].id).toBe(
      sceneReady.scene_plan.scenes[0].id,
    )

    await page.getByRole('button', { name: '模板视觉设置' }).click()
    const templateDialog = page.getByRole('dialog', {
      name: '模板视觉设置',
    })
    await expect(templateDialog).toBeVisible()
    await expect(
      templateDialog.getByRole('textbox', { name: '品牌标题' }),
    ).toHaveValue('CHANNEL DEFAULT')
    await expect(
      templateDialog.getByRole('switch', { name: '显示场景编号' }),
    ).toBeChecked()
    await expect(
      templateDialog.getByLabel('模板视觉草稿预览'),
    ).not.toContainText('WEMEDIA')

    await templateDialog.getByRole('textbox', { name: '品牌标题' })
      .fill('WORK OVERRIDE')
    await templateDialog.getByRole('switch', {
      name: '显示场景编号',
    }).click()
    const applyResponse = page.waitForResponse(response => (
      response.url() === `${harness.apiBase}/text-videos/${saved.id}`
      && response.request().method() === 'PATCH'
    ))
    await templateDialog.getByRole('button', { name: '应用' }).click()
    expect((await applyResponse).status()).toBe(200)
    await expect(templateDialog).toBeHidden()
    const overridden = await harness.waitForProject(
      saved.id,
      'work-level template override',
      project => (
        project.render_input.templateProps.brandTitle === 'WORK OVERRIDE'
        && project.render_input.templateProps.showSceneNumber === false
      ),
    )
    expect(overridden.render_input.templateProps).toMatchObject({
      brandTitle: 'WORK OVERRIDE',
      showSceneNumber: false,
    })

    await page.reload()
    await expect(page.getByTestId('remotion-preview')).toBeVisible({
      timeout: 20_000,
    })
    const reloaded = await harness.apiJson<TextVideoProject>(
      `/text-videos/${saved.id}`,
    )
    expect(reloaded).toMatchObject({
      speech_split_mode: 'auto',
      paragraphs: speechReady.paragraphs.map(segment => (
        expect.objectContaining({
          id: segment.id,
          text: segment.text,
          status: 'confirmed',
          audio_url: segment.audio_url,
        })
      )),
      master_audio: expect.objectContaining({
        status: 'ready',
        timeline_status: 'ready',
        sample_rate: 44_100,
        sample_count: 88_200,
      }),
      scene_plan: expect.objectContaining({
        status: 'ready',
        scenes: sceneReady.scene_plan.scenes,
      }),
      render_input: {
        ...sceneReady.render_input,
        templateProps: {
          ...sceneReady.render_input.templateProps,
          brandTitle: 'WORK OVERRIDE',
          showSceneNumber: false,
        },
      },
    })
    expect(reloaded.render_input.templateProps).toMatchObject({
      brandTitle: 'WORK OVERRIDE',
      showSceneNumber: false,
    })
    await expect(page.getByTestId('remotion-preview'))
      .toContainText('WORK OVERRIDE / 述策')
    await expect(page.getByTestId('remotion-preview'))
      .not.toContainText(/01\s*\/\s*01/u)
    await expect(page.getByTestId('remotion-preview'))
      .not.toContainText('WEMEDIA')

    await page.getByRole('button', { name: '模板视觉设置' }).click()
    const reloadedTemplateDialog = page.getByRole('dialog', {
      name: '模板视觉设置',
    })
    await expect(
      reloadedTemplateDialog.getByRole('textbox', {
        name: '品牌标题',
      }),
    ).toHaveValue('WORK OVERRIDE')
    await expect(
      reloadedTemplateDialog.getByRole('switch', {
        name: '显示场景编号',
      }),
    ).not.toBeChecked()
    await reloadedTemplateDialog.getByRole('button', {
      name: '取消',
    }).click()
    await expect(reloadedTemplateDialog).toBeHidden()

    await page.getByRole('combobox', { name: '视频模板' }).click()
    const v2Save = page.waitForResponse(response => (
      response.url() === `${harness.apiBase}/text-videos/${saved.id}`
      && response.request().method() === 'PATCH'
    ))
    await page.getByRole('option', { name: '动感大字 V2' }).click()
    expect((await v2Save).status()).toBe(200)
    await expect(page.getByRole('button', { name: '自动拆句' }))
      .toBeVisible()
    await expect(page.getByLabel('短句动作').first()).toBeVisible()
    const v2Project = await harness.waitForProject(
      saved.id,
      'persisted kinetic punch v2 motion plan',
      project => (
        project.render_input.templateId === 'kinetic-punch-v2'
        && project.scene_plan.scenes.every(scene => Boolean(scene.motion))
      ),
    )
    expect(v2Project.render_input.templateVersion).toBe(1)
    expect(v2Project.scene_plan.scenes.every(
      scene => (scene.motion?.chunks.length ?? 0) > 0,
    )).toBe(true)

    await page.getByRole('button', { name: 'AI 优化本场' }).click()
    const motionDialog = page.getByRole('dialog', {
      name: 'AI 动效优化',
    })
    await expect(motionDialog).toBeVisible()
    await expect(motionDialog.getByLabel('创意方向')).toBeVisible()
    await motionDialog.getByRole('button', { name: '取消' }).click()
    await expect(motionDialog).toBeHidden()
    await page.screenshot({
      path: '/tmp/kinetic-v2-editor-browser-qa.png',
      fullPage: false,
    })

    await page.reload()
    await expect(page.getByRole('button', { name: '自动拆句' }))
      .toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel('短句动作').first()).toBeVisible()

    await page.setViewportSize({ width: 1024, height: 800 })
    await expect(page.getByTestId('editor-shell')).toBeVisible()
    expect(await page.getByTestId('editor-shell').evaluate(
      element => element.getBoundingClientRect().width,
    )).toBeGreaterThanOrEqual(1_120)
    await expect(page.getByTestId('remotion-preview')).toBeVisible()

    expect(harness.provider.callCounts).toEqual({
      speech: 2,
      split: 1,
      scene: 1,
      transcription: 1,
    })
    expect(harness.speechSourceUrls).toEqual([
      OFFICIAL_MIMO_COMPLETION_URL,
      OFFICIAL_MIMO_COMPLETION_URL,
    ])
    const uploadFiles = await collectFiles(harness.uploadsRoot)
    expect(uploadFiles.length).toBeGreaterThan(0)
    expect(uploadFiles.every(path => (
      resolve(path).startsWith(`${resolve(harness.uploadsRoot)}/`)
    ))).toBe(true)
    expect(uploadFiles.some(path => path.endsWith('.mp3'))).toBe(true)
    await assertNoSyntheticUi(page, evidence)
    expect(evidence.externalRequests).toEqual([])
    expect(evidence.errors).toEqual([])
  } finally {
    await harness.close()
    await harness.attachDiagnostics(testInfo)
    expect(harness.cleanupErrors).toEqual([])
  }
})

test('stale TTS cannot overwrite a compact-width edit', async ({
  page,
}, testInfo) => {
  const latch = createDeferredTtsLatch({ text: SPLIT_TEXTS[0] })
  const harness = await TextVideoHarness.start({ ttsLatch: latch })
  const evidence = attachBrowserEvidence(page, harness)
  try {
    await page.setViewportSize({ width: 1024, height: 800 })
    const saved = await createAndEditProject(page, harness)
    expect(saved.paragraphs).toHaveLength(1)
    const split = await applyTwoSegmentAiSplit(page, harness, saved)
    const segmentId = split.paragraphs[0].id
    const untouchedId = split.paragraphs[1].id
    await page.getByRole('tab', { name: '配音制作' }).click()
    await waitForSaved(page)

    await page.getByTestId('speech-segment-card').filter({
      hasText: SPLIT_TEXTS[1],
    }).click()
    const untouchedLaunch = await clickAndReadLaunch(
      page,
      url => url.pathname.endsWith(
        `/text-videos/${saved.id}/speech-segments/`
        + `${encodeURIComponent(untouchedId)}/generate`,
      ),
      async () => {
        await page.getByRole('button', { name: '生成当前段' }).click()
      },
    )
    expect(untouchedLaunch.jobs).toHaveLength(1)
    expect((await harness.waitForTerminalJob(
      untouchedLaunch.jobs[0].id,
    )).status).toBe('succeeded')
    await expect(page.getByTestId('segment-audio')).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: '确认当前段' }).click()
    const beforeStale = await harness.waitForProject(
      saved.id,
      'untouched segment confirmed before stale race',
      project => project.paragraphs[1]?.status === 'confirmed',
    )
    const untouchedSegment = beforeStale.paragraphs[1]

    await page.getByTestId('speech-segment-card').filter({
      hasText: SPLIT_TEXTS[0],
    }).click()
    const launch = await clickAndReadLaunch(
      page,
      url => url.pathname.endsWith(
        `/text-videos/${saved.id}/speech-segments/`
        + `${encodeURIComponent(segmentId)}/generate`,
      ),
      async () => {
        await page.getByRole('button', { name: '生成当前段' }).click()
      },
    )
    expect(launch.jobs).toHaveLength(1)
    await latch.waitUntilObserved()

    await page.getByRole('tab', { name: '稿件与分镜' }).click()
    await initializeSaveObservation(page)
    await page.locator('#text-video-script').fill(EDITED_SEGMENT)
    await expect(
      page.getByTestId('text-video-save-status'),
    ).toContainText('有未保存更改')
    await waitForSaved(page)
    expect(await observedSaveStates(page)).toEqual(expect.arrayContaining([
      '有未保存更改',
      '正在保存',
      '已保存',
    ]))
    const edited = await harness.waitForProject(
      saved.id,
      'saved edit while old TTS is in flight',
      project => (
        project.script === EDITED_SCRIPT
        && project.paragraphs[0]?.text === EDITED_SEGMENT
        && project.paragraphs[0]?.status === 'draft'
        && project.paragraphs[1]?.status === 'confirmed'
      ),
    )
    expect(edited.paragraphs[0]).toMatchObject({
      id: segmentId,
      text: EDITED_SEGMENT,
      status: 'draft',
      audio_url: '',
    })
    expect(edited.paragraphs[1]).toEqual(untouchedSegment)

    latch.release()
    const staleJob = await harness.waitForTerminalJob(launch.jobs[0].id)
    expect(staleJob.status).toBe('failed')
    expect(staleJob.steps).toEqual([
      expect.objectContaining({
        key: 'generate_speech',
        status: 'failed',
        retryable: false,
      }),
    ])
    const retained = await harness.waitForProject(
      saved.id,
      'stale TTS rejected without overwriting edit',
      project => (
        project.script === EDITED_SCRIPT
        && project.paragraphs[0]?.text === EDITED_SEGMENT
        && project.paragraphs[0]?.status === 'draft'
        && project.paragraphs[0]?.audio_url === ''
        && project.paragraphs[1]?.status === 'confirmed'
      ),
    )
    expect(retained.paragraphs).toHaveLength(2)
    expect(retained.paragraphs[0].source_hash).toBe('')
    expect(retained.paragraphs[1]).toEqual(untouchedSegment)

    await page.getByRole('tab', { name: '配音制作' }).click()
    await page.getByTestId('speech-segment-card').filter({
      hasText: EDITED_SEGMENT,
    }).click()
    await expect(
      page.getByRole('button', { name: '生成当前段' }),
    ).toBeEnabled({ timeout: 20_000 })
    await expect(page.getByRole('blockquote')).toHaveText(EDITED_SEGMENT)
    await expect(page.getByTestId('segment-audio')).toHaveCount(0)
    await expect(page.getByText('可以重试当前操作')).toHaveCount(0)

    const retryLaunch = await clickAndReadLaunch(
      page,
      url => url.pathname.endsWith(
        `/text-videos/${saved.id}/speech-segments/generate-pending`,
      ),
      async () => {
        await page.getByRole('button', {
          name: '生成全部未生成段落',
        }).click()
      },
    )
    expect(retryLaunch.jobs).toEqual([
      expect.objectContaining({
        flow: 'text_video_speech',
        target_id: segmentId,
      }),
    ])
    expect((await harness.waitForTerminalJob(
      retryLaunch.jobs[0].id,
    )).status).toBe('succeeded')
    const retried = await harness.waitForProject(
      saved.id,
      'only edited segment regenerated',
      project => (
        project.paragraphs[0]?.status === 'ready'
        && project.paragraphs[0]?.audio_url !== ''
        && project.paragraphs[1]?.status === 'confirmed'
      ),
    )
    expect(retried.paragraphs[1]).toEqual(untouchedSegment)
    await expect(page.getByTestId('segment-audio')).toBeVisible({
      timeout: 20_000,
    })

    await page.reload()
    await expect(page.getByRole('blockquote')).toHaveText(EDITED_SEGMENT)
    const reloaded = await harness.apiJson<TextVideoProject>(
      `/text-videos/${saved.id}`,
    )
    expect(reloaded.paragraphs[0]).toMatchObject({
      id: segmentId,
      text: EDITED_SEGMENT,
      status: 'ready',
      audio_url: retried.paragraphs[0].audio_url,
    })
    expect(reloaded.paragraphs[1]).toEqual(untouchedSegment)

    expect(harness.provider.callCounts).toEqual({
      speech: 3,
      split: 1,
      scene: 0,
      transcription: 0,
    })
    expect(harness.speechSourceUrls).toEqual([
      OFFICIAL_MIMO_COMPLETION_URL,
      OFFICIAL_MIMO_COMPLETION_URL,
      OFFICIAL_MIMO_COMPLETION_URL,
    ])
    await assertNoSyntheticUi(page, evidence)
    expect(evidence.externalRequests).toEqual([])
    expect(evidence.errors).toEqual([])
  } finally {
    latch.release()
    await harness.close()
    await harness.attachDiagnostics(testInfo)
    expect(harness.cleanupErrors).toEqual([])
  }
})
