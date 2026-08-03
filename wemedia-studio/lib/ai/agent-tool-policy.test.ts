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
})
