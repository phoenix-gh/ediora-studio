import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createScriptedCodexPeer,
  requestByMethod,
  sentMethods,
} from '../../test/codex-jsonl-peer'
import {
  CODEX_HOME,
  CODEX_SANDBOX_MODES,
  CODEX_THREAD_CWD,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SANDBOX,
  codexAppServerSpawnOptions,
} from './codex-app-server'
import { listCodexModels, runCodexAgentTurn } from './codex-app-server-client'
import { runWithCodexTurnSignal } from './codex-turn-abort'
import { codexThreadModel } from './codex-model'

describe('Codex app-server client', () => {
  it('handshakes, starts a thread and turn, streams agent text, and finishes on turn/completed', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'Hello from Codex' })
    const deltas: string[] = []

    const result = await runCodexAgentTurn({
      transport: peer.transport,
      input: 'Summarize this repo.',
      onTextDelta: delta => {
        deltas.push(delta)
      },
    })

    expect(sentMethods(peer).slice(0, 4)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ])
    for (const message of peer.received) {
      expect(message).not.toHaveProperty('jsonrpc')
    }

    const initialize = requestByMethod(peer, 'initialize')
    expect(initialize?.params).toEqual(expect.objectContaining({
      clientInfo: expect.objectContaining({
        name: expect.any(String),
        version: expect.any(String),
      }),
    }))

    const threadModel = codexThreadModel()
    const threadStart = requestByMethod(peer, 'thread/start')
    expect(threadModel).toEqual({ model: 'deepseek-v4-flash', modelProvider: 'proxy' })
    expect(threadStart?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      modelProvider: threadModel.modelProvider,
    }))
    expect(CODEX_SANDBOX_MODES).toContain(threadStart?.params?.sandbox)
    expect(threadStart?.params?.sandbox).toBe(DEFAULT_CODEX_SANDBOX)

    const turnStart = requestByMethod(peer, 'turn/start')
    expect(turnStart?.params).toEqual(expect.objectContaining({
      threadId: 'thr_test',
      model: threadModel.model,
      input: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Summarize this repo.' }),
      ]),
    }))

    expect(deltas.join('')).toBe('Hello from Codex')
    expect(result.text).toBe('Hello from Codex')
    expect(result.threadId).toBe('thr_test')
    expect(result.status).toBe('completed')
    expect(result.initialize.codexHome).toBe('/home/violet/.mk-video-codex')
  })

  it('resumes an existing thread instead of starting a new one', async () => {
    const peer = createScriptedCodexPeer({
      agentText: 'continued',
      resumeThreadId: 'thr_existing',
    })

    const result = await runCodexAgentTurn({
      transport: peer.transport,
      threadId: 'thr_existing',
      input: 'Continue the work.',
    })

    expect(sentMethods(peer)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'turn/start',
    ])
    expect(requestByMethod(peer, 'thread/resume')?.params).toEqual(expect.objectContaining({
      threadId: 'thr_existing',
      model: 'deepseek-v4-flash',
      modelProvider: 'proxy',
    }))
    expect(CODEX_SANDBOX_MODES).toContain(
      requestByMethod(peer, 'thread/resume')?.params?.sandbox,
    )
    expect(requestByMethod(peer, 'turn/start')?.params).toEqual(expect.objectContaining({
      threadId: 'thr_existing',
      input: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Continue the work.' }),
      ]),
    }))
    expect(result.threadId).toBe('thr_existing')
    expect(result.text).toBe('continued')
  })

  it('starts the thread in ~/.ediora/codex_work', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })

    await runCodexAgentTurn({
      transport: peer.transport,
      input: 'hello',
    })

    expect(CODEX_THREAD_CWD).toBe(join(homedir(), '.ediora', 'codex_work'))
    expect(statSync(CODEX_THREAD_CWD).isDirectory()).toBe(true)
    expect(requestByMethod(peer, 'thread/start')?.params).toEqual(expect.objectContaining({
      cwd: CODEX_THREAD_CWD,
    }))
    expect(requestByMethod(peer, 'turn/start')?.params).toEqual(expect.objectContaining({
      cwd: CODEX_THREAD_CWD,
    }))
  })

  it('keeps a catalog model on the account provider', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })

    await runCodexAgentTurn({
      transport: peer.transport,
      input: 'hello',
      model: 'gpt-6.1-sol',
    })

    expect(requestByMethod(peer, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-6.1-sol',
    }))
    expect(requestByMethod(peer, 'thread/start')?.params).not.toHaveProperty('modelProvider')
  })

  it('sends a valid SandboxMode on thread/start even when callers pass the camelCase alias', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })

    await runCodexAgentTurn({
      transport: peer.transport,
      input: 'hello',
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'workspaceWrite',
    })

    const sandbox = requestByMethod(peer, 'thread/start')?.params?.sandbox
    expect(CODEX_SANDBOX_MODES).toEqual(['workspace-write', 'read-only', 'danger-full-access'])
    expect(CODEX_SANDBOX_MODES).toContain(sandbox)
    expect(sandbox).not.toBe('workspaceWrite')
  })

  it('uses an explicit model override on thread and turn start', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })

    await runCodexAgentTurn({
      transport: peer.transport,
      input: 'hello',
      model: 'gpt-5.4',
    })

    expect(requestByMethod(peer, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-5.4',
    }))
    expect(requestByMethod(peer, 'turn/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-5.4',
    }))
    expect(requestByMethod(peer, 'turn/start')?.params).not.toHaveProperty('effort')
  })

  it('sends the selected reasoning effort on the turn', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })

    await runCodexAgentTurn({
      transport: peer.transport,
      input: 'think harder',
      model: 'gpt-deep',
      reasoningEffort: 'high',
    })

    expect(requestByMethod(peer, 'thread/start')?.params).not.toHaveProperty('effort')
    expect(requestByMethod(peer, 'turn/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-deep',
      effort: 'high',
    }))
  })

  it('attaches MCP servers to the thread config and leaves the turn unchanged', async () => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })
    const mcpServers = {
      ediora: {
        url: 'http://localhost:8000/mcp',
        http_headers: {
          'X-Agent-Mode': 'chat',
          'X-Agent-Session-Id': '12',
        },
      },
    }

    await runCodexAgentTurn({
      transport: peer.transport,
      input: 'use the tools',
      mcpServers,
    })

    expect(requestByMethod(peer, 'thread/start')?.params).toEqual(expect.objectContaining({
      config: { mcp_servers: mcpServers },
    }))
    expect(requestByMethod(peer, 'turn/start')?.params).not.toHaveProperty('config')
  })

  it('lists models after the app-server handshake', async () => {
    const peer = createScriptedCodexPeer({
      models: [{ id: 'gpt-fast', model: 'gpt-fast', displayName: 'Fast' }],
    })

    await expect(listCodexModels({ transport: peer.transport })).resolves.toEqual([
      { id: 'gpt-fast', model: 'gpt-fast', displayName: 'Fast' },
    ])
    expect(sentMethods(peer).slice(0, 3)).toEqual([
      'initialize',
      'initialized',
      'model/list',
    ])
    expect(requestByMethod(peer, 'model/list')?.params).toEqual({
      limit: 100,
      includeHidden: false,
    })
  })

  it('fails the turn when the server emits turn/failed', async () => {
    const peer = createScriptedCodexPeer({
      agentText: '',
      terminal: 'failed',
      terminalMethod: 'turn/failed',
    })

    await expect(runCodexAgentTurn({
      transport: peer.transport,
      input: 'do the task',
    })).rejects.toThrow(/failed/i)
  })

  it('fails the turn when the server emits turn/cancelled', async () => {
    const peer = createScriptedCodexPeer({
      agentText: '',
      terminal: 'cancelled',
      terminalMethod: 'turn/cancelled',
    })

    await expect(runCodexAgentTurn({
      transport: peer.transport,
      input: 'do the task',
    })).rejects.toThrow(/cancel/i)
  })

  it('fails the turn when turn/completed reports a failed status', async () => {
    const peer = createScriptedCodexPeer({
      agentText: '',
      terminal: 'failed',
      terminalMethod: 'turn/completed',
    })

    await expect(runCodexAgentTurn({
      transport: peer.transport,
      input: 'do the task',
    })).rejects.toThrow(/failed/i)
  })

  it('fails the turn when the app-server closes without a terminal notification', async () => {
    const peer = createScriptedCodexPeer({ holdTurn: true, agentText: 'partial' })

    await expect(runCodexAgentTurn({
      transport: peer.transport,
      input: 'do the task',
      onTextDelta: () => {
        void peer.transport.close?.()
      },
    })).rejects.toThrow(/closed/i)
  })

  it('stops an open turn when the abort signal fires', async () => {
    const peer = createScriptedCodexPeer({ holdTurn: true, agentText: 'partial' })
    const controller = new AbortController()

    await expect(runCodexAgentTurn({
      transport: peer.transport,
      input: 'do the task',
      signal: controller.signal,
      onTextDelta: () => controller.abort(),
    })).rejects.toThrow(/cancel/i)
  })

  it('stops an open turn when the bound worker signal aborts', async () => {
    const peer = createScriptedCodexPeer({ holdTurn: true, agentText: 'partial' })
    const controller = new AbortController()

    await expect(runWithCodexTurnSignal(controller.signal, () => runCodexAgentTurn({
      transport: peer.transport,
      input: 'do the task',
      onTextDelta: () => controller.abort(),
    }))).rejects.toThrow(/cancel/i)
  })
})

describe('Codex app-server spawn', () => {
  it('pins CODEX_HOME and app-server argv on the shipped spawn path', () => {
    const spawn = codexAppServerSpawnOptions({
      env: { ...process.env, PATH: '/usr/bin', HOME: '/home/violet' },
    })

    expect(CODEX_HOME).toBe('/home/violet/.mk-video-codex')
    expect(DEFAULT_CODEX_MODEL).toBe('proxy/deepseek-v4-flash')
    expect(spawn.command).toBe('codex')
    expect(spawn.args).toEqual(['app-server'])
    expect(spawn.env.CODEX_HOME).toBe('/home/violet/.mk-video-codex')
    expect(spawn.env.PATH).toBe('/usr/bin')
  })
})
