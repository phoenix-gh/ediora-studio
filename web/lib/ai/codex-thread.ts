import type { RunCodexAgentTurnOptions } from './codex-app-server-client'

const CODEX_THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/

export function codexThreadId(value: unknown) {
  return typeof value === 'string' && CODEX_THREAD_ID.test(value) ? value : undefined
}

export function codexThreadTurnOptions(
  storedThreadId: unknown,
  remember?: (threadId: string) => Promise<unknown>,
): Pick<RunCodexAgentTurnOptions, 'threadId' | 'onThreadId'> {
  const threadId = codexThreadId(storedThreadId)
  if (threadId) return { threadId }
  return {
    onThreadId: async startedThreadId => {
      await remember?.(startedThreadId)
    },
  }
}
