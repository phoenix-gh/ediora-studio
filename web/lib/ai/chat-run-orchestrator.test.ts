import { describe, expect, it, vi } from 'vitest'

import { createChatRunOrchestrator } from './chat-run-orchestrator'
import type { AgentPreparedRun } from './agent-runtime'
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

function preparedRun(): AgentPreparedRun {
  return {
    selectedSkill: { name: 'writing-plan', version: '1', digest: 'b'.repeat(64), activation: 'manual' as const },
    skillRun: {
      skill: { name: 'writing-plan' }, activation: 'manual', userRequest: 'write',
      conversationContext: '', selectedContext: '', plan: { steps: [] }, run: { requiredTools: ['save_draft'] },
      loadedReferences: [], baseExecutionPrompt: 'execute frozen plan',
    },
    capabilitySnapshot: { schemaVersion: 1, mode: 'chat', skill: null, tools: [], policy: { approvalPolicy: 'interactive', allowedToolNames: null } },
  } as unknown as AgentPreparedRun
}

describe('durable Chat Run orchestrator', () => {
  it('freezes a manually selected Skill before exposing its approval', async () => {
    const prepared = preparedRun()
    const runtime = {
      prepareRun: vi.fn().mockResolvedValue(prepared),
      executePrepared: vi.fn().mockResolvedValue({
        kind: 'approval', text: '', revisionCount: 0,
        assistantContent: [
          { type: 'reasoning', text: 'research before save' },
          { type: 'tool-call', toolCallId: 'call-read', toolName: 'fetch_url', input: { url: 'https://example.com' } },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' } },
        ],
        parts: [
          {
            type: 'dynamic-tool', toolName: 'fetch_url', toolCallId: 'call-read',
            state: 'output-available', input: { url: 'https://example.com' }, output: { content: 'evidence' },
          },
          {
            type: 'dynamic-tool', toolName: 'save_draft', toolCallId: 'call-1',
            state: 'approval-requested', input: { title: 'one' }, approval: { id: 'approval-1' },
          },
        ],
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
      assistant_content: [
        { type: 'reasoning', text: 'research before save' },
        { type: 'tool-call', toolCallId: 'call-read', toolName: 'fetch_url', input: { url: 'https://example.com' } },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' } },
      ],
      tool_calls: expect.arrayContaining([
        expect.objectContaining({
          tool_call_id: 'call-read', tool_name: 'fetch_url', status: 'succeeded',
          output_data: { content: 'evidence' },
        }),
        expect.objectContaining({
          tool_call_id: 'call-1', approval_id: 'approval-1', tool_name: 'save_draft',
        }),
      ]),
    }))
    expect(projection).toMatchObject({ runId: 'run-1', status: 'waiting_approval' })
  })

  it('checkpoints completed read calls even when runtime assistant content only contains the pending write', async () => {
    const prepared = preparedRun()
    const runtime = {
      prepareRun: vi.fn().mockResolvedValue(prepared),
      executePrepared: vi.fn().mockResolvedValue({
        kind: 'approval', text: '', revisionCount: 0,
        assistantContent: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' } },
        ],
        parts: [
          {
            type: 'dynamic-tool', toolName: 'check_content_novelty', toolCallId: 'call-read',
            state: 'output-available', input: { topic: 'one' }, output: { decision: 'allow' },
          },
          {
            type: 'dynamic-tool', toolName: 'save_draft', toolCallId: 'call-1',
            state: 'approval-requested', input: { title: 'one' }, approval: { id: 'approval-1' },
          },
        ],
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
      persistence, openRuntime: vi.fn().mockResolvedValue(runtime), executeApprovedTool: vi.fn(),
    })

    await orchestrator.startRun({
      sessionId: 7, userMessageId: 11, objective: 'write',
      modelMessages: [{ role: 'user', content: 'write' }], maxSteps: 5,
    })

    expect(persistence.appendStep).toHaveBeenCalledWith(7, 'run-1', expect.objectContaining({
      assistant_content: expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', toolCallId: 'call-read' }),
      ]),
      tool_calls: expect.arrayContaining([
        expect.objectContaining({
          tool_call_id: 'call-read', tool_name: 'check_content_novelty',
          status: 'succeeded', output_data: { decision: 'allow' },
        }),
      ]),
    }))
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

  it('rehydrates completed checkpoint tools into the frozen Skill run before resuming', async () => {
    const prepared = preparedRun()
    prepared.skillRun!.run = {
      skillName: 'writing-plan', activation: 'manual', goal: 'write',
      steps: [{
        id: 'save', instruction: 'save', requiredReferences: [],
        requiredTools: ['save_draft'], status: 'pending', evidence: [],
      }],
      requiredReferences: [], loadedReferences: [], requiredTools: ['save_draft'],
      toolEvidence: [], outputRequirements: [], verificationCriteria: [],
      validation: { passed: false, violations: [] },
    }
    const afterResult = pendingCheckpoint('running')
    afterResult.run.validated_plan = { agent_prepared_run: prepared } as never
    afterResult.tool_calls[0] = {
      ...afterResult.tool_calls[0], status: 'succeeded', output_data: { saved: true, id: 862 },
    }
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
      completeToolCall: vi.fn(), transitionRun: vi.fn().mockResolvedValue(completed.run),
    }
    const orchestrator = createChatRunOrchestrator({
      persistence, openRuntime: vi.fn().mockResolvedValue(runtime),
      executeApprovedTool: vi.fn().mockResolvedValue({ saved: true, id: 862 }),
    })

    await orchestrator.resumeRun({
      sessionId: 7, runId: 'run-1', approvalId: 'approval-1',
      toolCallId: 'call-1', approved: true, maxSteps: 5,
    })

    const resumedPrepared = runtime.executePrepared.mock.calls[0]?.[0]?.prepared
    expect(resumedPrepared.skillRun.run).toMatchObject({
      steps: [{ id: 'save', status: 'completed' }],
      toolEvidence: [expect.objectContaining({
        stepId: 'save', toolName: 'save_draft', toolCallId: 'call-1', state: 'succeeded',
      })],
    })
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

  it('transitions the run to failed when canonical recovery history is invalid', async () => {
    const prepared = preparedRun()
    const afterResult = pendingCheckpoint('running')
    afterResult.run.validated_plan = { agent_prepared_run: prepared } as never
    afterResult.tool_calls[0] = {
      ...afterResult.tool_calls[0], status: 'succeeded', output_data: { saved: false },
    }
    afterResult.steps[0].assistant_content.push({
      type: 'tool-call', toolCallId: 'orphan-read', toolName: 'fetch_url', input: {},
    })
    const failed = structuredClone(afterResult)
    failed.run = { ...failed.run, status: 'failed', checkpoint_version: 4, error_data: { message: 'invalid history' } }
    const persistence = {
      createRun: vi.fn(), freezePreparation: vi.fn(), appendStep: vi.fn(),
      loadCheckpoint: vi.fn()
        .mockResolvedValueOnce({
          ...pendingCheckpoint('resuming'),
          run: { ...pendingCheckpoint('resuming').run, validated_plan: { agent_prepared_run: prepared } },
        })
        .mockResolvedValueOnce(afterResult)
        .mockResolvedValueOnce(afterResult)
        .mockResolvedValueOnce(failed),
      decideApproval: vi.fn().mockResolvedValue({ duplicate: false, decision: 'approved' }),
      completeToolCall: vi.fn(),
      transitionRun: vi.fn().mockResolvedValue(failed.run),
    }
    const openRuntime = vi.fn()
    const orchestrator = createChatRunOrchestrator({
      persistence,
      openRuntime,
      executeApprovedTool: vi.fn().mockResolvedValue({ saved: false }),
    })

    const projection = await orchestrator.resumeRun({
      sessionId: 7, runId: 'run-1', approvalId: 'approval-1',
      toolCallId: 'call-1', approved: true, maxSteps: 5,
    })

    expect(openRuntime).not.toHaveBeenCalled()
    expect(persistence.transitionRun).toHaveBeenCalledWith(7, 'run-1', expect.objectContaining({
      status: 'failed', error_data: expect.objectContaining({ message: expect.stringContaining('orphan-read') }),
    }))
    expect(projection.status).toBe('failed')
  })
})
