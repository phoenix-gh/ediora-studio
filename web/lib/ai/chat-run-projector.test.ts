import { describe, expect, it } from 'vitest'

import { projectChatRun } from './chat-run-projector'
import type { ChatRunCheckpoint } from './chat-run-types'

const checkpoint: ChatRunCheckpoint = {
  run: {
    id: 'run-1', session_id: 7, user_message_id: 11, assistant_message_id: 12,
    status: 'waiting_approval', objective: 'write', skill_invocation: { name: 'writing-plan' },
    validated_plan: {}, capability_snapshot: {}, current_step: 1,
    checkpoint_version: 2, error_data: null,
  },
  steps: [{
    id: 21, run_id: 'run-1', ordinal: 1, status: 'waiting_approval',
    assistant_content: [{
      type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' },
    }], finish_reason: 'tool-calls', usage_data: null,
  }],
  tool_calls: [{
    id: 31, run_id: 'run-1', step_id: 21, tool_call_id: 'call-1', tool_name: 'save_draft',
    input_data: { title: 'one' }, status: 'pending_approval', approval_id: 'approval-1',
    approval_decision: null, output_data: null, error_data: null, side_effecting: true,
    replay_policy: 'claim', concurrency_policy: 'serial',
    idempotency_key: 'chat-run:run-1:call-1', tool_version: '1', contract_digest: 'a'.repeat(64),
  }],
}

describe('Chat Run projection', () => {
  it('projects a durable approval containing run identity', () => {
    expect(projectChatRun(checkpoint)).toMatchObject({
      runId: 'run-1', status: 'waiting_approval',
      parts: [
        { type: 'data-chat-run', data: { runId: 'run-1', status: 'waiting_approval' } },
        {
          type: 'dynamic-tool', toolCallId: 'call-1', toolName: 'save_draft',
          state: 'approval-requested', approval: { id: 'approval-1' }, runId: 'run-1',
        },
      ],
    })
  })

  it('keeps a saved draft artifact visible beside a later run failure', () => {
    const failed: ChatRunCheckpoint = {
      run: { ...checkpoint.run, status: 'failed', error_data: { message: 'summary failed' } },
      steps: [{ ...checkpoint.steps[0], status: 'completed' }],
      tool_calls: [{
        ...checkpoint.tool_calls[0], status: 'succeeded',
        output_data: { saved: true, id: 862, title: 'draft' },
      }],
    }

    const projection = projectChatRun(failed)

    expect(projection.parts).toContainEqual({
      type: 'data-artifact', data: {
        kind: 'draft', id: 862, title: 'draft', url: '/drafts?draft=862',
      },
    })
    expect(projection.parts).toContainEqual(expect.objectContaining({
      type: 'data-chat-run-error', data: { message: 'summary failed' },
    }))
  })

  it('projects a saved draft artifact from an MCP text envelope', () => {
    const completed: ChatRunCheckpoint = {
      run: { ...checkpoint.run, status: 'completed' },
      steps: [{ ...checkpoint.steps[0], status: 'completed' }],
      tool_calls: [{
        ...checkpoint.tool_calls[0], status: 'succeeded',
        output_data: {
          content: [{
            type: 'text',
            text: JSON.stringify({ saved: true, id: 863, title: 'durable draft' }),
          }],
          isError: false,
        },
      }],
    }

    expect(projectChatRun(completed).parts).toContainEqual({
      type: 'data-artifact',
      data: { kind: 'draft', id: 863, title: 'durable draft', url: '/drafts?draft=863' },
    })
  })
})
