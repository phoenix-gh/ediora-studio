import { tool, type ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  AGENT_TOOL_POLICY_PROFILES,
  applyAgentToolPolicy,
  requiresToolApproval,
  resolveAgentToolPolicy,
  toolExecutionMetadata,
} from './agent-tool-policy'
import type { AgentToolAudit } from './agent-runtime-types'
import type { ToolContract } from './tool-contract'

type ExecutableTool = {
  needsApproval?: boolean
  execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown>
}

function executable(tools: ToolSet, name: string) {
  return tools[name] as unknown as ExecutableTool
}

function valueTool(onExecute: (value: string) => void = () => undefined) {
  return tool({
    description: 'Store one value.',
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }) => {
      onExecute(value)
      return { id: 7, value }
    },
  })
}

function contract(
  annotations: Partial<ToolContract['annotations']> = {},
  execution?: ToolContract['execution'],
): ToolContract {
  const resolvedAnnotations = {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    approval: 'never' as const,
    ...annotations,
  }
  return {
    name: 'test_tool',
    namespace: 'system',
    version: '1',
    description: 'Test one explicit policy contract.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: resolvedAnnotations,
    execution: execution ?? (resolvedAnnotations.readOnly
      ? { concurrency: 'parallel-safe', retry: 'safe' }
      : { concurrency: 'serialized', retry: 'claim-backed' }),
    availability: 'available',
    contractDigest: 'a'.repeat(64),
    source: 'native',
  }
}

describe('Agent tool policy', () => {
  it('defines explicit chat, scheduled, and response-writing profiles', () => {
    expect(resolveAgentToolPolicy('chat')).toEqual(AGENT_TOOL_POLICY_PROFILES.chat)
    expect(resolveAgentToolPolicy('chat')).toMatchObject({
      approvalPolicy: 'interactive',
      alwaysAvailableToolNames: ['generateImage'],
    })
    expect(resolveAgentToolPolicy('scheduled')).toMatchObject({
      approvalPolicy: 'automatic',
      allowedToolNames: undefined,
      blockedToolNames: ['upload_image_from_url', 'upload_image_from_path'],
    })
    expect(resolveAgentToolPolicy('response-writing')).toMatchObject({
      approvalPolicy: 'automatic',
      allowedToolNames: expect.arrayContaining([
        'list_drafts', 'get_draft', 'check_content_novelty', 'save_draft',
        'list_source_subscriptions', 'search_source_items', 'get_source_item',
      ]),
    })
  })

  it('classifies usage-ledger recording as a fenced side effect', () => {
    expect(requiresToolApproval('record_content_usage')).toBe(true)
  })

  it('uses explicit annotations instead of misleading tool names', () => {
    expect(requiresToolApproval(
      'get_but_actually_writes',
      contract({ readOnly: false, idempotent: false, approval: 'writes' }),
    )).toBe(true)
    expect(requiresToolApproval(
      'save_but_read_only',
      contract({ readOnly: true, approval: 'never' }),
    )).toBe(false)
    expect(requiresToolApproval('save_item')).toBe(true)
  })

  it('declares conservative concurrency and idempotency metadata', () => {
    expect(toolExecutionMetadata('list_drafts')).toEqual({
      concurrencyPolicy: 'parallel-safe', idempotencyPolicy: 'replayable',
    })
    expect(toolExecutionMetadata('save_draft')).toEqual({
      concurrencyPolicy: 'serialized', idempotencyPolicy: 'claim-backed',
    })
    expect(toolExecutionMetadata('generateImage')).toEqual({
      concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown',
    })
    expect(toolExecutionMetadata('custom_tool')).toEqual({
      concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown',
    })
    expect(toolExecutionMetadata(
      'opaque_action',
      contract({ readOnly: false }, { concurrency: 'serialized', retry: 'unsafe' }),
    )).toEqual({
      concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown',
    })
  })

  it('serializes tools marked as serialized while keeping parallel-safe tools concurrent', async () => {
    let active = 0
    let maxActive = 0
    const release: Array<() => void> = []
    const tools = applyAgentToolPolicy({
      save_item: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => new Promise(resolve => {
          active += 1
          maxActive = Math.max(maxActive, active)
          release.push(() => {
            active -= 1
            resolve(value)
          })
        }),
      }),
    }, { policy: 'automatic' })

    const first = executable(tools, 'save_item').execute(
      { value: 'first' }, { toolCallId: 'first' },
    )
    await vi.waitFor(() => expect(release).toHaveLength(1))
    const second = executable(tools, 'save_item').execute(
      { value: 'second' }, { toolCallId: 'second' },
    )
    await Promise.resolve()
    expect(release).toHaveLength(1)
    expect(maxActive).toBe(1)

    release[0]?.()
    await vi.waitFor(() => expect(release).toHaveLength(2))
    release[1]?.()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('runs an explicitly parallel-safe tool concurrently despite an opaque name', async () => {
    let active = 0
    let maxActive = 0
    const release: Array<() => void> = []
    const explicit = contract({}, { concurrency: 'parallel-safe', retry: 'safe' })
    const tools = applyAgentToolPolicy({
      opaque_action: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => new Promise(resolve => {
          active += 1
          maxActive = Math.max(maxActive, active)
          release.push(() => {
            active -= 1
            resolve(value)
          })
        }),
      }),
    }, {
      policy: 'automatic',
      contracts: new Map([['opaque_action', explicit]]),
    })

    const first = executable(tools, 'opaque_action').execute(
      { value: 'first' }, { toolCallId: 'first' },
    )
    const second = executable(tools, 'opaque_action').execute(
      { value: 'second' }, { toolCallId: 'second' },
    )
    await vi.waitFor(() => expect(release).toHaveLength(2))
    expect(maxActive).toBe(2)
    release.forEach(resolve => resolve())
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })

  it('keeps approval=always gated in automatic mode', () => {
    const explicit = contract({
      readOnly: false,
      idempotent: false,
      approval: 'always',
    })
    const tools = applyAgentToolPolicy({ opaque_action: valueTool() }, {
      policy: 'automatic',
      contracts: new Map([['opaque_action', explicit]]),
    })

    expect(executable(tools, 'opaque_action').needsApproval).toBe(true)
  })

  it('audits approval=never writes as side effects without prompting', async () => {
    const audits: AgentToolAudit[] = []
    const explicit = contract({
      readOnly: false,
      idempotent: false,
      approval: 'never',
    }, { concurrency: 'serialized', retry: 'unsafe' })
    const tools = applyAgentToolPolicy({ generateImage: valueTool() }, {
      policy: 'interactive',
      contracts: new Map([['generateImage', explicit]]),
      onAudit: event => { audits.push(event) },
    })

    expect(executable(tools, 'generateImage').needsApproval).toBe(false)
    await executable(tools, 'generateImage').execute(
      { value: 'prompt' }, { toolCallId: 'image-call' },
    )
    expect(audits[0]).toMatchObject({
      sideEffecting: true,
      autoApproved: false,
      status: 'started',
    })
  })

  it('automatically approves a sensitive tool and audits its real result', async () => {
    const audits: AgentToolAudit[] = []
    const tools = applyAgentToolPolicy({ save_item: valueTool() }, {
      policy: 'automatic',
      onAudit: event => { audits.push(event) },
    })

    expect(executable(tools, 'save_item').needsApproval).toBe(false)
    await expect(executable(tools, 'save_item').execute(
      { value: 'x' }, { toolCallId: 'call-1' },
    )).resolves.toEqual({ id: 7, value: 'x' })
    expect(audits).toEqual([
      expect.objectContaining({
        toolName: 'save_item', toolCallId: 'call-1', sideEffecting: true,
        autoApproved: true, status: 'started', inputSummary: { value: 'x' },
      }),
      expect.objectContaining({
        toolName: 'save_item', toolCallId: 'call-1', sideEffecting: true,
        autoApproved: true, status: 'succeeded', output: { id: 7, value: 'x' },
      }),
    ])
  })

  it('keeps sensitive tools gated in interactive mode and read tools ungated', () => {
    const interactive = applyAgentToolPolicy({
      save_item: valueTool(),
      list_items: valueTool(),
    }, { policy: 'interactive' })

    expect(executable(interactive, 'save_item').needsApproval).toBe(true)
    expect(executable(interactive, 'list_items').needsApproval).toBe(false)
  })

  it('replays a completed call without invoking its underlying side effect', async () => {
    let executions = 0
    const tools = applyAgentToolPolicy({
      save_item: valueTool(() => { executions += 1 }),
    }, {
      policy: 'automatic',
      beforeToolExecute: async () => ({ action: 'replay', output: { id: 19, value: 'stored' } }),
    })

    await expect(executable(tools, 'save_item').execute(
      { value: 'new' }, { toolCallId: 'call-replay' },
    )).resolves.toEqual({ id: 19, value: 'stored' })
    expect(executions).toBe(0)
  })

  it('stops an uncertain side effect without invoking its underlying tool', async () => {
    let executions = 0
    const tools = applyAgentToolPolicy({
      save_item: valueTool(() => { executions += 1 }),
    }, {
      policy: 'automatic',
      beforeToolExecute: async () => ({ action: 'uncertain', error: 'prior write outcome is unknown' }),
    })

    await expect(executable(tools, 'save_item').execute(
      { value: 'new' }, { toolCallId: 'call-uncertain' },
    )).rejects.toThrow('prior write outcome is unknown')
    expect(executions).toBe(0)
  })

  it('executes a newly claimed call and records a bounded failure', async () => {
    const audits: AgentToolAudit[] = []
    const tools = applyAgentToolPolicy({
      save_item: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async (): Promise<unknown> => { throw new Error('write failed') },
      }),
    }, {
      policy: 'automatic',
      beforeToolExecute: async () => ({ action: 'execute' }),
      onAudit: event => { audits.push(event) },
    })

    await expect(executable(tools, 'save_item').execute(
      { value: 'x' }, { toolCallId: 'call-failed' },
    )).rejects.toThrow('write failed')
    expect(audits.at(-1)).toMatchObject({ status: 'failed', error: 'write failed' })
  })

  it('audits an MCP error result as failed while returning it to the model', async () => {
    const audits: AgentToolAudit[] = []
    const result = {
      content: [{
        type: 'text',
        text: 'Error executing tool save_item: item is not eligible',
      }],
      isError: true,
    }
    const tools = applyAgentToolPolicy({
      save_item: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async () => result,
      }),
    }, {
      policy: 'automatic',
      onAudit: event => { audits.push(event) },
    })

    await expect(executable(tools, 'save_item').execute(
      { value: 'x' }, { toolCallId: 'call-mcp-error' },
    )).resolves.toEqual(result)
    expect(audits.at(-1)).toMatchObject({
      status: 'failed',
      error: 'Error executing tool save_item: item is not eligible',
      output: result,
    })
  })

  it('audits a replayed MCP error result as failed', async () => {
    const audits: AgentToolAudit[] = []
    const result = {
      content: [{ type: 'text', text: 'stored MCP failure' }],
      isError: true,
    }
    const tools = applyAgentToolPolicy({ save_item: valueTool() }, {
      policy: 'automatic',
      beforeToolExecute: async () => ({ action: 'replay', output: result }),
      onAudit: event => { audits.push(event) },
    })

    await expect(executable(tools, 'save_item').execute(
      { value: 'x' }, { toolCallId: 'call-replay-error' },
    )).resolves.toEqual(result)
    expect(audits.at(-1)).toMatchObject({
      status: 'failed', error: 'stored MCP failure', output: result,
    })
  })

  it('preserves evidence ids when a successful audit result is too large', async () => {
    const audits: AgentToolAudit[] = []
    const candidates = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      asset_id: index + 101,
      summary: 'x'.repeat(500),
    }))
    const tools = applyAgentToolPolicy({
      list_creative_asset_candidates: tool({
        inputSchema: z.object({}),
        execute: async () => candidates,
      }),
    }, {
      policy: 'automatic',
      onAudit: event => { audits.push(event) },
    })

    await executable(tools, 'list_creative_asset_candidates').execute(
      {}, { toolCallId: 'large-candidates' },
    )

    expect(audits.at(-1)?.output).toEqual(expect.objectContaining({
      truncated: true,
      evidenceIds: Array.from({ length: 50 }, (_, index) => index + 1),
      evidenceAssetIds: Array.from({ length: 50 }, (_, index) => index + 101),
    }))
    expect(JSON.stringify(audits.at(-1)?.output).length).toBeLessThan(8_000)
  })
})
