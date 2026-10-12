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

export const CODEX_HOME = '/home/violet/.mk-video-codex'
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

export function spawnCodexAppServerTransport(overrides: {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
} = {}): CodexJsonlTransport {
  return transportFromCodexProcess(spawnCodexAppServerProcess(overrides))
}
