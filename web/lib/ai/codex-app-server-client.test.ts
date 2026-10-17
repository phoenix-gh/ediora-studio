import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  createScriptedCodexPeer,
  requestByMethod,
  sentMethods,
} from '../../test/codex-jsonl-peer'
import {
  CODEX_APP_SERVER_URL,
  CODEX_HOME,
  CODEX_SANDBOX_MODES,
  resolveCodexHome,
  CODEX_THREAD_CWD,
  DEFAULT_CODEX_MODEL,
  codexAppServerSpawnOptions,
  connectCodexAppServer,
  spawnCodexAppServerTransport,
  type CodexJsonlTransport,
} from './codex-app-server'
import { deleteCodexThread, listCodexModels, runCodexAgentTurn } from './codex-app-server-client'
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
      capabilities: { experimentalApi: true },
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
    expect(threadStart?.params?.sandbox).toBeUndefined()
    expect(threadStart?.params?.permissions).toBe('ediora-workspace')
    expect(threadStart?.params?.config).toEqual({
      default_permissions: 'ediora-workspace',
      permissions: {
        'ediora-workspace': {
          extends: ':workspace',
          filesystem: Object.fromEntries(['.agents', '.codex', '.git', '.aws'].map(name => [join(CODEX_THREAD_CWD, name), 'write'])),
          network: { enabled: true },
        },
      },
    })

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
    expect(result.initialize.codexHome).toBe(join(homedir(), '.mk-video-codex'))
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
    expect(requestByMethod(peer, 'thread/resume')?.params?.permissions).toBe('ediora-workspace')
    expect(requestByMethod(peer, 'thread/resume')?.params?.sandbox).toBeUndefined()
    expect(requestByMethod(peer, 'thread/resume')?.params?.config).toMatchObject({
      default_permissions: 'ediora-workspace',
    })
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

  it('applies workspace permissions even when callers pass the camelCase alias', async () => {
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
    expect(sandbox).toBeUndefined()
    expect(requestByMethod(peer, 'thread/start')?.params?.permissions).toBe('ediora-workspace')
    expect(requestByMethod(peer, 'thread/start')?.params?.config).toMatchObject({
      permissions: { 'ediora-workspace': { filesystem: { [join(process.cwd(), '.agents')]: 'write' }, network: { enabled: true } } },
    })
  })

  it.each(['read-only', 'danger-full-access'])('preserves an explicit %s sandbox without adding workspace permissions', async sandbox => {
    const peer = createScriptedCodexPeer({ agentText: 'ok' })
    await runCodexAgentTurn({ transport: peer.transport, input: 'hello', sandbox })
    expect(requestByMethod(peer, 'thread/start')?.params?.sandbox).toBe(sandbox)
    expect(requestByMethod(peer, 'thread/start')?.params).not.toHaveProperty('permissions')
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
      config: expect.objectContaining({ mcp_servers: mcpServers, permissions: expect.any(Object) }),
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

  it('permanently deletes a persisted thread after the handshake', async () => {
    const peer = createScriptedCodexPeer()
    let closed = false
    const close = peer.transport.close?.bind(peer.transport)
    peer.transport.close = () => {
      closed = true
      close?.()
    }

    await deleteCodexThread('thr_chat', { transport: peer.transport })

    expect(sentMethods(peer).slice(0, 3)).toEqual([
      'initialize',
      'initialized',
      'thread/delete',
    ])
    expect(requestByMethod(peer, 'thread/delete')?.params).toEqual({ threadId: 'thr_chat' })
    expect(closed).toBe(true)
  })

  it('treats an ephemeral thread as already gone', async () => {
    const peer = createScriptedCodexPeer({
      deleteError: 'thread is not persisted and cannot be deleted: thr_side',
    })

    await expect(deleteCodexThread('thr_side', { transport: peer.transport })).resolves.toBeUndefined()
  })

  it('reports a thread delete failure from app-server', async () => {
    const peer = createScriptedCodexPeer({
      deleteError: 'cannot delete thread thr_parent: forked history still references it',
    })

    await expect(deleteCodexThread('thr_parent', { transport: peer.transport })).rejects.toThrow(
      'forked history still references it',
    )
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

  it('steers and interrupts an active native turn and returns its partial answer', async () => {
    const peer = createScriptedCodexPeer({ holdTurn: true, agentText: 'partial answer' })
    let control: import('./codex-app-server-client').CodexTurnControl | undefined
    const result = runCodexAgentTurn({
      transport: peer.transport, input: 'start', allowInterrupted: true,
      onTurnStarted: value => { control = value },
    })
    void result.catch(() => undefined)
    try {
      await vi.waitFor(() => expect(control).toBeDefined())
      await control!.steer('new instruction')
      await control!.interrupt()
      expect(requestByMethod(peer, 'turn/steer')?.params).toMatchObject({
        threadId: 'thr_test', expectedTurnId: 'turn_test',
        input: [{ type: 'text', text: 'new instruction', text_elements: [] }],
      })
      expect(requestByMethod(peer, 'turn/interrupt')?.params).toEqual({ threadId: 'thr_test', turnId: 'turn_test' })
      await expect(result).resolves.toMatchObject({ status: 'interrupted', text: 'partial answer' })
    } finally {
      await peer.transport.close?.()
      await result.catch(() => undefined)
    }
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

    expect(CODEX_HOME).toBe(resolveCodexHome())
    expect(resolveCodexHome({}, '/home/someone')).toBe('/home/someone/.mk-video-codex')
    expect(resolveCodexHome({ CODEX_HOME: '  /root/.codex  ' }, '/home/someone')).toBe('/root/.codex')
    expect(DEFAULT_CODEX_MODEL).toBe('proxy/deepseek-v4-flash')
    expect(spawn.command).toBe('codex')
    expect(spawn.args).toEqual(['app-server'])
    expect(spawn.env.CODEX_HOME).toBe(resolveCodexHome())
    expect(spawn.env.PATH).toBe('/usr/bin')
  })

  it('uses the fixed loopback websocket and falls back to one process when it is down', async () => {
    expect(CODEX_APP_SERVER_URL).toBe('ws://127.0.0.1:4500')

    const shared: CodexJsonlTransport = {
      write() {},
      lines: (async function* lines() {})(),
    }
    let spawnCount = 0
    const spawnProcess = () => {
      spawnCount += 1
      return fakeCodexChild()
    }

    await expect(spawnCodexAppServerTransport({}, {
      connect: async () => shared,
      spawnProcess,
    })).resolves.toBe(shared)
    expect(spawnCount).toBe(0)

    const fallback = await spawnCodexAppServerTransport({}, {
      connect: () => new Promise((_, reject) => {
        setImmediate(() => reject(new Error('Codex app-server refused ws://127.0.0.1:4500')))
      }),
      spawnProcess,
    })
    expect(spawnCount).toBe(1)
    await fallback.close?.()

    await spawnCodexAppServerTransport({
      command: 'codex',
      args: ['app-server'],
    }, {
      connect: async () => {
        throw new Error('shared server should not be dialed for an explicit command')
      },
      spawnProcess,
    }).then(transport => transport.close?.())
    expect(spawnCount).toBe(2)
  })
})

function fakeCodexChild() {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  return {
    stdout,
    stdin,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() {
      this.killed = true
      stdout.end()
      stdin.end()
      return true
    },
    once() {
      return this
    },
  } as never
}

class FakeCodexSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const current = this.listeners.get(type) ?? []
    current.push(listener)
    this.listeners.set(type, current)
  }

  emit(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }
}

describe('Codex app-server websocket', () => {
  it('sends one JSON-RPC message per text frame and closes only the client', async () => {
    const socket = new FakeCodexSocket()
    const connecting = connectCodexAppServer(CODEX_APP_SERVER_URL, () => socket, 1_000)
    socket.readyState = 1
    socket.emit('open')
    const transport = await connecting

    const received: string[] = []
    const reading = (async () => {
      for await (const line of transport.lines) received.push(line)
    })()
    await transport.write('{"method":"initialize","id":0}\n')
    expect(socket.sent).toEqual(['{"method":"initialize","id":0}'])
    socket.emit('message', { data: '{"id":0,"result":{"ok":true}}' })
    socket.emit('message', { data: '{"method":"initialized"}\n' })
    await new Promise(resolve => setImmediate(resolve))
    await transport.close?.()
    await reading

    expect(received).toEqual([
      '{"id":0,"result":{"ok":true}}\n',
      '{"method":"initialized"}\n',
    ])
    expect(socket.closed).toBe(true)
  })

  it('rejects and closes the socket when the shared port refuses the connection', async () => {
    const socket = new FakeCodexSocket()
    const connecting = connectCodexAppServer(CODEX_APP_SERVER_URL, () => socket, 1_000)
    socket.emit('error')
    await expect(connecting).rejects.toThrow('ws://127.0.0.1:4500')
    expect(socket.closed).toBe(true)
  })

  it('stops waiting when the shared port does not answer', async () => {
    const socket = new FakeCodexSocket()
    await expect(connectCodexAppServer(CODEX_APP_SERVER_URL, () => socket, 20)).rejects.toThrow(
      'ws://127.0.0.1:4500',
    )
    expect(socket.closed).toBe(true)
  })
})
