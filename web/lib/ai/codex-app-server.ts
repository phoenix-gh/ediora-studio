import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export { DEFAULT_CODEX_MODEL } from '@/lib/ai/codex-model'

export type CodexJsonlTransport = {
  write(line: string): void | Promise<void>
  lines: AsyncIterable<string>
  close?: () => void | Promise<void>
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const configured = env.CODEX_HOME?.trim()
  return configured || join(home, '.mk-video-codex')
}

export const CODEX_HOME = resolveCodexHome()
export const CODEX_THREAD_CWD = join(homedir(), '.ediora', 'codex_work')

export function ensureCodexThreadCwd() {
  mkdirSync(CODEX_THREAD_CWD, { recursive: true })
  return CODEX_THREAD_CWD
}
export const CODEX_SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access'] as const
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]
export const DEFAULT_CODEX_SANDBOX: CodexSandboxMode = 'workspace-write'
export const CODEX_APP_SERVER_COMMAND = 'codex'
export const CODEX_APP_SERVER_ARGS = ['app-server'] as const
export const CODEX_APP_SERVER_URL = 'ws://127.0.0.1:4500'

const WEBSOCKET_CONNECTING = 0
const WEBSOCKET_OPEN = 1
const SHARED_SERVER_CONNECT_TIMEOUT_MS = 400

type CodexSocketEvent = { data?: unknown }

type CodexAppServerSocket = {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: CodexSocketEvent) => void): void
}

const SANDBOX_ALIASES: Record<string, CodexSandboxMode> = {
  'workspace-write': 'workspace-write',
  workspaceWrite: 'workspace-write',
  'read-only': 'read-only',
  readOnly: 'read-only',
  'danger-full-access': 'danger-full-access',
  dangerFullAccess: 'danger-full-access',
}

export function codexSandboxMode(value?: string | null): CodexSandboxMode {
  if (!value) return DEFAULT_CODEX_SANDBOX
  return SANDBOX_ALIASES[value] ?? DEFAULT_CODEX_SANDBOX
}

export type CodexAppServerSpawnOptions = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

export function codexAppServerSpawnOptions(overrides: {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
} = {}): CodexAppServerSpawnOptions {
  return {
    command: overrides.command ?? CODEX_APP_SERVER_COMMAND,
    args: [...(overrides.args ?? CODEX_APP_SERVER_ARGS)],
    env: {
      ...(overrides.env ?? process.env),
      CODEX_HOME,
    },
    cwd: overrides.cwd,
  }
}

export function transportFromCodexProcess(
  child: ChildProcessWithoutNullStreams,
): CodexJsonlTransport {
  if (!child.stdout || !child.stdin) {
    throw new Error('codex app-server process is missing stdio pipes')
  }
  const stdout = createInterface({ input: child.stdout })
  return {
    write(line: string) {
      const payload = line.endsWith('\n') ? line : `${line}\n`
      child.stdin.write(payload)
    },
    lines: (async function* lines() {
      for await (const line of stdout) {
        yield `${line}\n`
      }
    })(),
    close() {
      stdout.close()
      if (child.exitCode !== null || child.signalCode !== null || child.killed) return
      try {
        child.kill('SIGTERM')
      } catch {
        return
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // The process already exited.
          }
        }
      }, 2_000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
    },
  }
}

export function spawnCodexAppServerProcess(overrides: {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
} = {}): ChildProcessWithoutNullStreams {
  const options = codexAppServerSpawnOptions(overrides)
  return spawn(options.command, options.args, {
    env: options.env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function websocketFrameText(data: unknown) {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  return ''
}

export function transportFromWebSocket(socket: CodexAppServerSocket): CodexJsonlTransport {
  const pending: string[] = []
  let waiter: (() => void) | undefined
  let ended = false
  let closing = false
  let endError: Error | undefined

  const wake = () => {
    const current = waiter
    waiter = undefined
    current?.()
  }

  socket.addEventListener('message', event => {
    const text = websocketFrameText(event.data)
    if (!text) return
    pending.push(text.endsWith('\n') ? text : `${text}\n`)
    wake()
  })
  socket.addEventListener('error', () => {
    if (closing) return
    endError = new Error(`Codex app-server websocket failed: ${CODEX_APP_SERVER_URL}`)
    wake()
  })
  socket.addEventListener('close', () => {
    ended = true
    wake()
  })

  return {
    write(line: string) {
      if (socket.readyState !== WEBSOCKET_OPEN) {
        throw new Error('Codex app-server websocket is closed')
      }
      socket.send(line.endsWith('\n') ? line.slice(0, -1) : line)
    },
    lines: (async function* lines() {
      for (;;) {
        if (pending.length > 0) {
          const next = pending.shift()
          if (next) yield next
          continue
        }
        if (ended) break
        if (endError) throw endError
        await new Promise<void>(resolve => {
          waiter = resolve
        })
      }
      if (endError) throw endError
    })(),
    close() {
      closing = true
      ended = true
      wake()
      if (socket.readyState === WEBSOCKET_CONNECTING || socket.readyState === WEBSOCKET_OPEN) {
        socket.close()
      }
    },
  }
}

function defaultCodexSocket(url: string): CodexAppServerSocket {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket is not available')
  }
  return new WebSocket(url)
}

export function connectCodexAppServer(
  url = CODEX_APP_SERVER_URL,
  createSocket: (url: string) => CodexAppServerSocket = defaultCodexSocket,
  timeoutMs = SHARED_SERVER_CONNECT_TIMEOUT_MS,
): Promise<CodexJsonlTransport> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url)
    const transport = transportFromWebSocket(socket)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void Promise.resolve(transport.close?.()).catch(() => undefined)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`Codex app-server did not accept ${url}`))
    }, timeoutMs)
    timer.unref?.()
    const succeed = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(transport)
    }

    socket.addEventListener('open', succeed)
    socket.addEventListener('error', () => {
      fail(new Error(`Codex app-server refused ${url}`))
    })
    if (socket.readyState === WEBSOCKET_OPEN) succeed()
  })
}

let warnedSharedServerUnavailable = false

function warnCodexSharedServerUnavailable(error: unknown) {
  if (warnedSharedServerUnavailable) return
  warnedSharedServerUnavailable = true
  const detail = error instanceof Error ? error.message : String(error)
  console.warn(
    `Codex app-server at ${CODEX_APP_SERVER_URL} is not available (${detail}). Starting one process for this turn.`,
  )
}

export async function spawnCodexAppServerTransport(overrides: {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
} = {}, dependencies: {
  connect?: () => Promise<CodexJsonlTransport>
  spawnProcess?: typeof spawnCodexAppServerProcess
} = {}): Promise<CodexJsonlTransport> {
  if (overrides.command === undefined && overrides.args === undefined) {
    try {
      return await (dependencies.connect ?? (() => connectCodexAppServer()))()
    } catch (error) {
      warnCodexSharedServerUnavailable(error)
    }
  }
  return transportFromCodexProcess(
    (dependencies.spawnProcess ?? spawnCodexAppServerProcess)(overrides),
  )
}
