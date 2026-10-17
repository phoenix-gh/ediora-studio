import { join } from 'node:path'

import {
  CODEX_THREAD_CWD,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SANDBOX,
  codexSandboxMode,
  ensureCodexThreadCwd,
  spawnCodexAppServerTransport,
  type CodexJsonlTransport,
  type CodexSandboxMode,
} from './codex-app-server'
import { codexThreadModel } from './codex-model'
import { currentCodexTurnSignal } from './codex-turn-abort'

export type { CodexJsonlTransport }

export type CodexNotification = {
  method: string
  params?: Record<string, unknown>
}

export type CodexAgentTurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type CodexAgentTurnResult = {
  threadId: string
  turnId: string | null
  text: string
  status: CodexAgentTurnStatus
  items: Record<string, unknown>[]
  initialize: {
    userAgent?: string
    codexHome?: string
    platformFamily?: string
    platformOs?: string
  }
}

export type CodexMcpToolApprovalMode = 'auto' | 'prompt' | 'writes' | 'approve'

export type CodexTurnControl = {
  threadId: string
  turnId: string
  steer: (text: string) => Promise<void>
  interrupt: () => Promise<void>
}

export type CodexMcpHttpServer = {
  url: string
  http_headers?: Record<string, string>
  enabled?: boolean
  startup_timeout_sec?: number
  default_tools_approval_mode?: CodexMcpToolApprovalMode
}

export type RunCodexAgentTurnOptions = {
  input: string
  threadId?: string
  model?: string
  reasoningEffort?: string
  cwd?: string
  approvalPolicy?: string
  sandbox?: CodexSandboxMode | 'workspaceWrite' | 'readOnly' | 'dangerFullAccess' | string
  mcpServers?: Record<string, CodexMcpHttpServer>
  clientInfo?: {
    name: string
    title?: string | null
    version: string
  }
  transport?: CodexJsonlTransport
  createTransport?: () => CodexJsonlTransport | Promise<CodexJsonlTransport>
  onNotification?: (notification: CodexNotification) => void
  onTextDelta?: (delta: string) => void
  onThreadId?: (threadId: string) => void | Promise<void>
  onTurnStarted?: (control: CodexTurnControl) => void
  allowInterrupted?: boolean
  keepAlive?: boolean
  signal?: AbortSignal
}

type JsonRpcMessage = {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string; code?: number; data?: unknown }
}

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const DEFAULT_CLIENT_INFO = {
  name: 'wemediastudio',
  title: 'WeMediaStudio',
  version: '0.1.0',
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function textField(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function encodeLine(message: Record<string, unknown>) {
  return `${JSON.stringify(message)}\n`
}

function userInput(text: string) {
  return { type: 'text', text, text_elements: [] as const }
}

function isTerminalTurnMethod(method: string) {
  return method === 'turn/completed' || method === 'turn/failed' || method === 'turn/cancelled'
}

function turnStatusFromNotification(notification: CodexNotification): CodexAgentTurnStatus {
  if (notification.method === 'turn/failed') return 'failed'
  if (notification.method === 'turn/cancelled') return 'cancelled'
  const turn = record(record(notification.params).turn)
  const status = textField(turn.status)
  if (status === 'failed') return 'failed'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'cancelled') return 'cancelled'
  return 'completed'
}

function turnErrorMessage(notification: CodexNotification, status: CodexAgentTurnStatus) {
  const params = record(notification.params)
  const turn = record(params.turn)
  const error = record(turn.error)
  return textField(params.message)
    || textField(error.message)
    || (status === 'cancelled' ? 'Codex turn cancelled' : `Codex turn ${status}`)
}

function agentTextFromItems(items: Record<string, unknown>[]) {
  return items
    .filter(item => item.type === 'agentMessage' && typeof item.text === 'string')
    .map(item => String(item.text))
    .join('')
}

function itemsFromTurn(turn: Record<string, unknown>) {
  return Array.isArray(turn.items)
    ? turn.items.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ))
    : []
}

export async function runCodexAgentTurn(
  options: RunCodexAgentTurnOptions,
): Promise<CodexAgentTurnResult> {
  const transport = options.transport
    ?? await (options.createTransport ?? spawnCodexAppServerTransport)()
  const pending = new Map<number, PendingRequest>()
  let nextId = 0
  let closed = false
  const deltas: string[] = []
  const completedItems: Record<string, unknown>[] = []
  let terminal: { status: CodexAgentTurnStatus; notification: CodexNotification } | undefined
  let resolveTerminal: (() => void) | undefined
  const terminalWait = new Promise<void>(resolve => {
    resolveTerminal = resolve
  })

  const finishTerminal = (notification: CodexNotification) => {
    if (terminal) return
    terminal = {
      status: turnStatusFromNotification(notification),
      notification,
    }
    resolveTerminal?.()
  }

  const writeMessage = async (message: Record<string, unknown>) => {
    await transport.write(encodeLine(message))
  }

  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId
    nextId += 1
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    await writeMessage({ method, id, params })
    return result
  }

  const handleMessage = (message: JsonRpcMessage) => {
    if (message.id !== undefined && pending.has(Number(message.id))) {
      const waiter = pending.get(Number(message.id))
      pending.delete(Number(message.id))
      if (message.error) {
        waiter?.reject(new Error(message.error.message || `Codex RPC error for id ${message.id}`))
        return
      }
      waiter?.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string' || message.id !== undefined) return
    const notification: CodexNotification = {
      method: message.method,
      params: record(message.params),
    }
    options.onNotification?.(notification)
    if (notification.method === 'item/agentMessage/delta') {
      const delta = textField(record(notification.params).delta)
      if (delta) {
        deltas.push(delta)
        options.onTextDelta?.(delta)
      }
    }
    if (notification.method === 'item/completed') {
      const item = record(record(notification.params).item)
      if (Object.keys(item).length > 0) completedItems.push(item)
    }
    if (isTerminalTurnMethod(notification.method)) {
      const turn = record(record(notification.params).turn)
      completedItems.push(...itemsFromTurn(turn))
      finishTerminal(notification)
    }
  }

  const failOpenTurn = (
    status: CodexAgentTurnStatus,
    method: string,
    message: string,
  ) => {
    const failure = new Error(message)
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
    if (!terminal) {
      terminal = {
        status,
        notification: { method, params: { message } },
      }
      resolveTerminal?.()
    }
    return failure
  }

  const reading = (async () => {
    try {
      for await (const line of transport.lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        handleMessage(JSON.parse(trimmed) as JsonRpcMessage)
      }
      if (!closed) failOpenTurn('failed', 'turn/failed', 'Codex app-server closed')
    } catch (error) {
      if (!closed) {
        const failure = error instanceof Error ? error : new Error(String(error))
        failOpenTurn('failed', 'turn/failed', failure.message)
      }
    }
  })()

  const signal = options.signal ?? currentCodexTurnSignal()
  const abortTurn = () => {
    failOpenTurn('cancelled', 'turn/cancelled', 'Codex turn cancelled')
    void Promise.resolve(transport.close?.()).catch(() => undefined)
  }
  if (signal) {
    if (signal.aborted) abortTurn()
    else signal.addEventListener('abort', abortTurn, { once: true })
  }

  try {
    if (signal?.aborted) throw new Error('Codex turn cancelled')
    const initializeResult = record(await request('initialize', {
      clientInfo: {
        name: options.clientInfo?.name ?? DEFAULT_CLIENT_INFO.name,
        title: options.clientInfo?.title ?? DEFAULT_CLIENT_INFO.title,
        version: options.clientInfo?.version ?? DEFAULT_CLIENT_INFO.version,
      },
      capabilities: { experimentalApi: true },
    }))
    await writeMessage({ method: 'initialized' })

    const selectedModel = codexThreadModel(options.model ?? DEFAULT_CODEX_MODEL)
    const model = selectedModel.model
    const sandbox = codexSandboxMode(options.sandbox ?? DEFAULT_CODEX_SANDBOX)
    const cwd = options.cwd && options.cwd !== CODEX_THREAD_CWD
      ? options.cwd
      : ensureCodexThreadCwd()
    const threadParams: Record<string, unknown> = { model, cwd }
    const config: Record<string, unknown> = {}
    if (sandbox === 'workspace-write') {
      // Use a named profile to explicitly allow workspace metadata directories;
      // legacy workspace-write always protects these even with writableRoots.
      threadParams.permissions = 'ediora-workspace'
      config.default_permissions = 'ediora-workspace'
      config.permissions = {
        'ediora-workspace': {
          extends: ':workspace',
          filesystem: Object.fromEntries(
            ['.agents', '.codex', '.git', '.aws'].map(name => [join(cwd, name), 'write']),
          ),
          network: { enabled: true },
        },
      }
    } else {
      threadParams.sandbox = sandbox
    }
    if (selectedModel.modelProvider) threadParams.modelProvider = selectedModel.modelProvider
    if (options.approvalPolicy) threadParams.approvalPolicy = options.approvalPolicy
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      config.mcp_servers = options.mcpServers
    }
    if (Object.keys(config).length > 0) threadParams.config = config

    let threadId = options.threadId
    if (threadId) {
      const resumed = record(await request('thread/resume', {
        threadId,
        ...threadParams,
      }))
      threadId = textField(record(resumed.thread).id) ?? threadId
    } else {
      const started = record(await request('thread/start', threadParams))
      threadId = textField(record(started.thread).id)
      if (!threadId) throw new Error('Codex thread/start did not return a thread id')
    }
    await options.onThreadId?.(threadId)

    const turnParams: Record<string, unknown> = {
      threadId,
      model,
      cwd,
      input: [userInput(options.input)],
    }
    if (options.reasoningEffort) turnParams.effort = options.reasoningEffort
    if (options.approvalPolicy) turnParams.approvalPolicy = options.approvalPolicy

    const turnStart = record(await request('turn/start', turnParams))
    const startedTurnId = textField(record(turnStart.turn).id) ?? null
    if (startedTurnId) {
      options.onTurnStarted?.({
        threadId,
        turnId: startedTurnId,
        steer: async text => {
          await request('turn/steer', { threadId, expectedTurnId: startedTurnId, input: [userInput(text)] })
        },
        interrupt: async () => {
          await request('turn/interrupt', { threadId, turnId: startedTurnId })
        },
      })
    }
    await terminalWait
    if (!terminal) throw new Error('Codex turn ended without a terminal notification')

    const status = terminal.status
    if (status !== 'completed' && !(options.allowInterrupted && status === 'interrupted')) {
      throw new Error(turnErrorMessage(terminal.notification, status))
    }

    const turn = record(record(terminal.notification.params).turn)
    const text = deltas.join('') || agentTextFromItems(completedItems) || agentTextFromItems(itemsFromTurn(turn))
    return {
      threadId,
      turnId: textField(turn.id) ?? startedTurnId,
      text,
      status,
      items: completedItems.length > 0 ? completedItems : itemsFromTurn(turn),
      initialize: {
        userAgent: textField(initializeResult.userAgent),
        codexHome: textField(initializeResult.codexHome),
        platformFamily: textField(initializeResult.platformFamily),
        platformOs: textField(initializeResult.platformOs),
      },
    }
  } finally {
    closed = true
    for (const waiter of pending.values()) waiter.reject(new Error('Codex turn has ended'))
    pending.clear()
    signal?.removeEventListener('abort', abortTurn)
    if (!options.keepAlive) await transport.close?.()
    await reading?.catch(() => undefined)
  }
}

const MODEL_LIST_TIMEOUT_MS = 15_000
const THREAD_DELETE_TIMEOUT_MS = 20_000

function codexThreadHasNoRollout(error: Error) {
  return error.message.includes('is not persisted and cannot be deleted')
}

export async function deleteCodexThread(
  threadId: string,
  options: {
    transport?: CodexJsonlTransport
    createTransport?: () => CodexJsonlTransport | Promise<CodexJsonlTransport>
  } = {},
): Promise<void> {
  const transport = options.transport
    ?? await (options.createTransport ?? spawnCodexAppServerTransport)()
  const pending = new Map<number, PendingRequest>()
  let nextId = 0
  let closed = false

  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  const reading = (async () => {
    try {
      for await (const line of transport.lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const message = JSON.parse(trimmed) as JsonRpcMessage
        if (message.id === undefined || !pending.has(Number(message.id))) continue
        const waiter = pending.get(Number(message.id))
        pending.delete(Number(message.id))
        if (message.error) waiter?.reject(new Error(message.error.message || 'Codex thread delete failed'))
        else waiter?.resolve(message.result)
      }
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId
    nextId += 1
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    await transport.write(encodeLine({ method, id, params }))
    return result
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex thread delete timed out')), THREAD_DELETE_TIMEOUT_MS)
    timer.unref?.()
  })

  try {
    await Promise.race([
      (async () => {
        await request('initialize', {
          clientInfo: DEFAULT_CLIENT_INFO,
          capabilities: null,
        })
        await transport.write(encodeLine({ method: 'initialized' }))
        try {
          await request('thread/delete', { threadId })
        } catch (error) {
          if (error instanceof Error && codexThreadHasNoRollout(error)) return
          throw error
        }
      })(),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
    closed = true
    await transport.close?.()
    await reading.catch(() => undefined)
  }
}


export async function listCodexModels(options: {
  transport?: CodexJsonlTransport
  createTransport?: () => CodexJsonlTransport | Promise<CodexJsonlTransport>
  includeHidden?: boolean
} = {}): Promise<unknown[]> {
  const transport = options.transport
    ?? await (options.createTransport ?? spawnCodexAppServerTransport)()
  const pending = new Map<number, PendingRequest>()
  let nextId = 0
  let closed = false

  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  const reading = (async () => {
    try {
      for await (const line of transport.lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const message = JSON.parse(trimmed) as JsonRpcMessage
        if (message.id === undefined || !pending.has(Number(message.id))) continue
        const waiter = pending.get(Number(message.id))
        pending.delete(Number(message.id))
        if (message.error) waiter?.reject(new Error(message.error.message || 'Codex model list failed'))
        else waiter?.resolve(message.result)
      }
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId
    nextId += 1
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    await transport.write(encodeLine({ method, id, params }))
    return result
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex model list timed out')), MODEL_LIST_TIMEOUT_MS)
    timer.unref?.()
  })

  try {
    return await Promise.race([
      (async () => {
        await request('initialize', {
          clientInfo: DEFAULT_CLIENT_INFO,
          capabilities: null,
        })
        await transport.write(encodeLine({ method: 'initialized' }))
        const models: unknown[] = []
        let cursor: string | undefined
        for (let page = 0; page < 5; page += 1) {
          const params: Record<string, unknown> = {
            limit: 100,
            includeHidden: options.includeHidden ?? false,
          }
          if (cursor) params.cursor = cursor
          const result = record(await request('model/list', params))
          if (Array.isArray(result.data)) models.push(...result.data)
          cursor = textField(result.nextCursor)
          if (!cursor) break
        }
        return models
      })(),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
    closed = true
    await transport.close?.()
    await reading.catch(() => undefined)
  }
}
