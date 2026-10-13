import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createScriptedCodexPeer,
  requestByMethod,
  sentMethods,
} from '../../../test/codex-jsonl-peer'
import { CODEX_THREAD_CWD, DEFAULT_CODEX_MODEL } from '@/lib/ai/codex-app-server'
import { codexThreadModel } from '@/lib/ai/codex-model'

const api = vi.hoisted(() => ({
  after: vi.fn(),
  appendAgentLogEvent: vi.fn(),
  appendAgentSessionEvent: vi.fn(),
  pending: [] as Promise<unknown>[],
  peer: undefined as ReturnType<typeof createScriptedCodexPeer> | undefined,
}))

vi.mock('next/server', async importOriginal => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: api.after,
}))

vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute }) => {
      const writer = {
        merge: (stream: { run?: () => Promise<void> }) => {
          if (stream.run) api.pending.push(stream.run())
        },
        write: vi.fn(),
      }
      api.pending.push(Promise.resolve(execute({ writer })))
      return { kind: 'test-chat-stream' }
    }),
    createUIMessageStreamResponse: vi.fn(() => new Response('ok')),
    safeValidateUIMessages: vi.fn(async ({ messages }) => ({ success: true, data: messages })),
  }
})

vi.mock('@/lib/ai/agent-log-client', () => ({
  appendAgentLogEvent: api.appendAgentLogEvent,
  appendAgentSessionEvent: api.appendAgentSessionEvent,
}))

vi.mock('@/lib/ai/codex-app-server', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ai/codex-app-server')>()
  return {
    ...actual,
    spawnCodexAppServerTransport: () => {
      if (!api.peer) throw new Error('Codex test peer was not installed')
      return api.peer.transport
    },
  }
})

vi.mock('@/lib/ai/global-chat-tools', () => ({
  createDirectImageGenerator: vi.fn(() => vi.fn()),
  mcpUrl: vi.fn(() => 'http://mcp.example'),
}))

vi.mock('@/lib/skills/bindings', () => ({
  resolveSkillBinding: vi.fn(() => ({ displayName: 'Alpha' })),
}))

vi.mock('@/lib/skills/registry', () => ({
  getEnabledSkill: vi.fn(async () => ({ name: 'alpha', instructions: 'Use the Skill.' })),
  listSkillReferences: vi.fn(async () => []),
  loadSkillPreloadContext: vi.fn(async () => ({ references: [] })),
}))

import { POST } from './route'

async function flushRouteWork() {
  for (let index = 0; index < 5; index += 1) {
    const pending = api.pending.splice(0)
    if (pending.length === 0) break
    await Promise.all(pending)
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function postChat(text = 'hello') {
  const response = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 12,
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text }] }],
    }),
  }) as never)
  await flushRouteWork()
  if (response.status !== 200) throw new Error(await response.text())
  return response
}

describe('POST /api/chat Codex app-server agent', () => {
  beforeEach(() => {
    process.env.API_URL = 'http://api:8000/api'
    process.env.WORKER_TOKEN = 'test-worker-token-at-least-32-characters'
    api.after.mockImplementation(callback => callback())
    api.appendAgentLogEvent.mockResolvedValue({})
    api.appendAgentSessionEvent.mockResolvedValue({})
    api.pending = []
    api.peer = createScriptedCodexPeer({ agentText: 'Codex answer' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/chat/sessions/12') && !url.includes('/messages')) {
        return new Response(JSON.stringify({
          messages: [{ id: 1, role: 'user', parts: [{ type: 'text', text: 'Summarize this repo.' }] }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete process.env.API_URL
    delete process.env.WORKER_TOKEN
  })

  it('drives a user turn through initialize, thread/start, and turn/start', async () => {
    expect((await postChat('Summarize this repo.')).status).toBe(200)

    expect(sentMethods(api.peer!).slice(0, 4)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ])
    for (const message of api.peer!.received) {
      expect(message).not.toHaveProperty('jsonrpc')
    }
    const threadModel = codexThreadModel(DEFAULT_CODEX_MODEL)
    expect(requestByMethod(api.peer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      modelProvider: threadModel.modelProvider,
      cwd: CODEX_THREAD_CWD,
    }))
    expect(requestByMethod(api.peer!, 'turn/start')?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      input: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Summarize this repo.') }),
      ]),
    }))
    expect(requestByMethod(api.peer!, 'turn/start')?.params).not.toHaveProperty('effort')
    expect(requestByMethod(api.peer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      config: {
        mcp_servers: {
          ediora: {
            url: 'http://api:8000/mcp',
            http_headers: {
              'X-Agent-Mode': 'chat',
              'X-Agent-Session-Id': '12',
            },
          },
        },
      },
    }))
    const turnEnd = api.appendAgentSessionEvent.mock.calls
      .map(call => call[0] as { type?: string, data?: { reason?: unknown } })
      .find(event => event.type === 'turn/end')
    expect(turnEnd?.data?.reason).toEqual({ kind: 'completed' })
  })

  it('forwards the selected model and reasoning effort to the Codex turn', async () => {
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 12,
        model: 'gpt-deep',
        reasoningEffort: 'high',
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Summarize this repo.' }] }],
      }),
    }) as never)
    await flushRouteWork()
    expect(response.status).toBe(200)
    expect(requestByMethod(api.peer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-deep',
    }))
    expect(requestByMethod(api.peer!, 'turn/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-deep',
      effort: 'high',
    }))
  })

  it('does not open the built-in AI SDK agent runtime', async () => {
    const source = await import('fs/promises').then(fs => fs.readFile(
      new URL('./route.ts', import.meta.url),
      'utf8',
    ))
    expect(source).not.toMatch(/openAgentRuntime/)
    expect(source).not.toMatch(/\bstreamText\b/)
    expect(source).not.toMatch(/\bgenerateText\b/)
    expect((await postChat('Summarize this repo.')).status).toBe(200)
    expect(sentMethods(api.peer!).includes('turn/start')).toBe(true)
  })
})
