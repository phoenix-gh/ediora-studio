import { tool, type ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { applyAgentToolPolicy } from './agent-tool-policy'
import type { AgentToolAudit } from './agent-runtime-types'

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

describe('Agent tool policy', () => {
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
