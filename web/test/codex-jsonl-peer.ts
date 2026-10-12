import type { CodexJsonlTransport } from '../lib/ai/codex-app-server'

export type JsonRpcMessage = {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

export type ScriptedCodexPeerOptions = {
  agentText?: string
  threadId?: string
  turnId?: string
  codexHome?: string
  resumeThreadId?: string
  terminal?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  terminalMethod?: 'turn/completed' | 'turn/failed' | 'turn/cancelled'
  holdTurn?: boolean
  completedItems?: Record<string, unknown>[]
  models?: unknown[]
}

function createLineQueue() {
  const lines: string[] = []
  let closed = false
  let wake: (() => void) | undefined
  return {
    push(line: string) {
      lines.push(line)
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async *iterate() {
      while (true) {
        while (lines.length > 0) {
          yield lines.shift() as string
        }
        if (closed) return
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    },
  }
}

export function createScriptedCodexPeer(script: ScriptedCodexPeerOptions = {}) {
  const received: JsonRpcMessage[] = []
  const inbound = createLineQueue()
  const agentText = script.agentText ?? 'streamed agent reply'
  const threadId = script.threadId ?? 'thr_test'
  const turnId = script.turnId ?? 'turn_test'
  const codexHome = script.codexHome ?? '/home/violet/.mk-video-codex'
  const terminal = script.terminal ?? 'completed'
  const terminalMethod = script.terminalMethod ?? (
    terminal === 'cancelled' ? 'turn/cancelled' : terminal === 'failed' ? 'turn/failed' : 'turn/completed'
  )
  const extraItems = script.completedItems ?? []

  const reply = (message: unknown) => {
    inbound.push(`${JSON.stringify(message)}\n`)
  }

  const agentItem = {
    type: 'agentMessage',
    id: 'item_agent',
    text: agentText,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  }

  const turnPayload = (status: string) => ({
    id: turnId,
    items: status === 'completed' ? [agentItem, ...extraItems] : extraItems,
    itemsView: 'full',
    status,
    error: status === 'failed'
      ? { message: 'turn failed', codexErrorInfo: null, additionalDetails: null, misalignment: null }
      : null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 10,
  })

  const handle = (message: JsonRpcMessage) => {
    if (message.method === 'initialize' && message.id !== undefined) {
      reply({
        id: message.id,
        result: {
          userAgent: 'codex-test',
          codexHome,
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      })
      return
    }
    if (
      (message.method === 'thread/start' || message.method === 'thread/resume')
      && message.id !== undefined
    ) {
      const sandbox = message.params?.sandbox
      if (
        sandbox !== undefined
        && sandbox !== 'workspace-write'
        && sandbox !== 'read-only'
        && sandbox !== 'danger-full-access'
      ) {
        reply({
          id: message.id,
          error: { message: `invalid sandbox: ${String(sandbox)}` },
        })
        return
      }
      if (message.method === 'thread/start') {
        reply({ id: message.id, result: { thread: { id: threadId } } })
        return
      }
      reply({
        id: message.id,
        result: { thread: { id: script.resumeThreadId ?? threadId } },
      })
      return
    }
    if (message.method === 'model/list' && message.id !== undefined) {
      reply({
        id: message.id,
        result: {
          data: script.models ?? [],
          nextCursor: null,
        },
      })
      return
    }
    if (message.method === 'turn/start' && message.id !== undefined) {
      reply({ id: message.id, result: { turn: turnPayload('inProgress') } })
      const params = message.params ?? {}
      const activeThreadId = typeof params.threadId === 'string' ? params.threadId : threadId
      const chunks = agentText.length > 8
        ? [agentText.slice(0, 8), agentText.slice(8)]
        : [agentText]
      for (const delta of chunks) {
        reply({
          method: 'item/agentMessage/delta',
          params: {
            threadId: activeThreadId,
            turnId,
            itemId: 'item_agent',
            delta,
          },
        })
      }
      for (const item of extraItems) {
        reply({
          method: 'item/completed',
          params: {
            threadId: activeThreadId,
            turnId,
            completedAtMs: 2,
            item,
          },
        })
      }
      if (script.holdTurn) return
      if (terminalMethod === 'turn/completed') {
        reply({
          method: 'turn/completed',
          params: { threadId: activeThreadId, turn: turnPayload(terminal) },
        })
      } else {
        reply({
          method: terminalMethod,
          params: {
            threadId: activeThreadId,
            turn: turnPayload(terminal === 'cancelled' ? 'interrupted' : 'failed'),
            message: terminal === 'cancelled' ? 'turn cancelled' : 'turn failed',
          },
        })
      }
    }
  }

  const transport: CodexJsonlTransport = {
    write(line: string) {
      const parsed = JSON.parse(line) as JsonRpcMessage
      received.push(parsed)
      handle(parsed)
    },
    lines: inbound.iterate(),
    close() {
      inbound.close()
    },
  }

  return { transport, received }
}

export function sentMethods(peer: { received: JsonRpcMessage[] }) {
  return peer.received
    .map(message => message.method)
    .filter((method): method is string => typeof method === 'string')
}

export function requestByMethod(peer: { received: JsonRpcMessage[] }, method: string) {
  return peer.received.find(message => message.method === method && message.id !== undefined)
}
