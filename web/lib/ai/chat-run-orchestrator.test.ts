import { describe, expect, it, vi } from 'vitest'

import { createChatRunOrchestrator } from './chat-run-orchestrator'
import type { ChatRunCheckpoint, ChatRunRecord } from './chat-run-types'

const run = (status: ChatRunRecord['status'], version: number): ChatRunRecord => ({
  id: 'run-1', session_id: 7, user_message_id: 11, assistant_message_id: 12,
  status, objective: 'write', skill_invocation: { name: 'writing-plan', activation: 'manual' },
  validated_plan: null, capability_snapshot: {}, current_step: status === 'preparing' ? 0 : 1,
  checkpoint_version: version, error_data: null,
})

const pendingCheckpoint = (status: ChatRunRecord['status'] = 'waiting_approval'): ChatRunCheckpoint => ({
  run: run(status, 2),
  steps: [{
    id: 21, run_id: 'run-1', ordinal: 1,
    status: status === 'waiting_approval' ? 'waiting_approval' : 'completed',
    assistant_content: [{
      type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' },
    }], finish_reason: 'tool-calls', usage_data: null,
  }],
  tool_calls: [{
    id: 31, run_id: 'run-1', step_id: 21, tool_call_id: 'call-1', tool_name: 'save_draft',
    input_data: { title: 'one' }, status: status === 'waiting_approval' ? 'pending_approval' : 'approved',
    approval_id: 'approval-1', approval_decision: status === 'waiting_approval' ? null : { decision: 'approved' },
    output_data: null, error_data: null, side_effecting: true, replay_policy: 'claim',
    concurrency_policy: 'serial', idempotency_key: 'chat-run:run-1:call-1',
    tool_version: '1', contract_digest: 'a'.repeat(64),
  }],
})

function preparedRun() {
  return {
    selectedSkill: { name: 'writing-plan', version: '1', digest: 'b'.repeat(64), activation: 'manual' as const },
    skillRun: {
      skill: { name: 'writing-plan' }, activation: 'manual', userRequest: 'write',
      conversationContext: '', selectedContext: '', plan: { steps: [] }, run: { requiredTools: ['save_draft'] },
      loadedReferences: [], baseExecutionPrompt: 'execute frozen plan',
    },
    capabilitySnapshot: { schemaVersion: 1, mode: 'chat', skill: null, tools: [], policy: { approvalPolicy: 'interactive', allowedToolNames: null } },
  }
}

describe('durable Chat Run orchestrator', () => {
  it('freezes a manually selected Skill before exposing its approval', async () => {
    const prepared = preparedRun()
    const runtime = {
      prepareRun: vi.fn().mockResolvedValue(prepared),
      executePrepared: vi.fn().mockResolvedValue({
        kind: 'approval', text: '', revisionCount: 0,
        parts: [{
          type: 'dynamic-tool', toolName: 'save_draft', toolCallId: 'call-1',
          state: 'approval-requested', input: { title: 'one' }, approval: { id: 'approval-1' },
        }],
      }),
      close: vi.fn(),
    }
    const persistence = {
      createRun: vi.fn().mockResolvedValue(run('preparing', 0)),
      freezePreparation: vi.fn().mockResolvedValue(run('running', 1)),
      appendStep: vi.fn().mockResolvedValue({}),
      loadCheckpoint: vi.fn().mockResolvedValue(pendingCheckpoint()),
      decideApproval: vi.fn(), completeToolCall: vi.fn(), transitionRun: vi.fn(),
    }
    const orchestrator = createChatRunOrchestrator({
      persistence, openRuntime: vi.fn().mockResolvedValue(runtime),
      executeApprovedTool: vi.fn(),
    })

    const projection = await orchestrator.startRun({
      sessionId: 7, userMessageId: 11, objective: 'write',
      modelMessages: [{ role: 'user', content: 'write' }], maxSteps: 5,
    })

    expect(persistence.freezePreparation).toHaveBeenCalledWith(7, 'run-1', expect.objectContaining({
      expected_version: 0,
      skill_invocation: expect.objectContaining({ name: 'writing-plan', activation: 'manual' }),
      validated_plan: { agent_prepared_run: prepared },
    }))
    expect(persistence.appendStep).toHaveBeenCalledWith(7, 'run-1', expect.objectContaining({
      expected_version: 1,
      tool_calls: [expect.objectContaining({
        tool_call_id: 'call-1', approval_id: 'approval-1', tool_name: 'save_draft',
      })],
    }))
    expect(projection).toMatchObject({ runId: 'run-1', status: 'waiting_approval' })
  })

  it('persists the approved write result before continuing the frozen run', async () => {
    const prepared = preparedRun()
    const afterResult = pendingCheckpoint('running')
    afterResult.tool_calls[0] = {
      ...afterResult.tool_calls[0], status: 'succeeded', output_data: { saved: true, id: 862 },
    }
    afterResult.run.validated_plan = { agent_prepared_run: prepared } as never
    const completed = structuredClone(afterResult)
    completed.run = { ...completed.run, status: 'completed', checkpoint_version: 5 }
    const runtime = {
      prepareRun: vi.fn(),
      executePrepared: vi.fn().mockResolvedValue({
        kind: 'completed', text: 'saved', parts: [{ type: 'text', text: 'saved' }], revisionCount: 0,
      }),
      close: vi.fn(),
    }
    const persistence = {
      createRun: vi.fn(), freezePreparation: vi.fn(), appendStep: vi.fn().mockResolvedValue({}),
      loadCheckpoint: vi.fn()
        .mockResolvedValueOnce({
          ...pendingCheckpoint('resuming'),
          run: { ...pendingCheckpoint('resuming').run, validated_plan: { agent_prepared_run: prepared } },
        })
        .mockResolvedValueOnce(afterResult)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce(completed),
      decideApproval: vi.fn().mockResolvedValue({ duplicate: false, decision: 'approved', run_status: 'resuming' }),
      completeToolCall: vi.fn().mockResolvedValue({}),
      transitionRun: vi.fn().mockResolvedValue(completed.run),
    }
    const executeApprovedTool = vi.fn().mockResolvedValue({ saved: true, id: 862 })
    const orchestrator = createChatRunOrchestrator({
      persistence, openRuntime: vi.fn().mockResolvedValue(runtime), executeApprovedTool,
    })

    const projection = await orchestrator.resumeRun({
      sessionId: 7, runId: 'run-1', approvalId: 'approval-1',
      toolCallId: 'call-1', approved: true, maxSteps: 5,
    })

    expect(executeApprovedTool).toHaveBeenCalledTimes(1)
    expect(persistence.completeToolCall).toHaveBeenCalledBefore(runtime.executePrepared)
    expect(runtime.executePrepared).toHaveBeenCalledWith(expect.objectContaining({
      prepared,
      modelMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'tool', content: [expect.objectContaining({ toolCallId: 'call-1' })] }),
      ]),
    }))
    expect(projection.parts).toContainEqual(expect.objectContaining({
      type: 'data-artifact', data: expect.objectContaining({ id: 862 }),
    }))
  })

  it('terminates a rejected approval without opening a runtime or executing a tool', async () => {
    const rejected = pendingCheckpoint('completed')
    rejected.tool_calls[0] = {
      ...rejected.tool_calls[0], status: 'rejected', approval_decision: { decision: 'rejected' },
      output_data: { approved: false, error: 'tool_execution_denied' },
    }
    const persistence = {
      createRun: vi.fn(), freezePreparation: vi.fn(), appendStep: vi.fn(),
      loadCheckpoint: vi.fn().mockResolvedValue(rejected),
      decideApproval: vi.fn().mockResolvedValue({ duplicate: false, decision: 'rejected', run_status: 'completed' }),
      completeToolCall: vi.fn(), transitionRun: vi.fn(),
    }
    const openRuntime = vi.fn()
    const executeApprovedTool = vi.fn()
    const orchestrator = createChatRunOrchestrator({ persistence, openRuntime, executeApprovedTool })

    const projection = await orchestrator.resumeRun({
      sessionId: 7, runId: 'run-1', approvalId: 'approval-1',
      toolCallId: 'call-1', approved: false, maxSteps: 5,
    })

    expect(openRuntime).not.toHaveBeenCalled()
    expect(executeApprovedTool).not.toHaveBeenCalled()
    expect(projection.status).toBe('completed')
  })
})
