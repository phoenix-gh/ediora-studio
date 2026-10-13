import { modelMessageSchema } from 'ai'
import { describe, expect, it } from 'vitest'

import { buildCanonicalModelMessages, ChatRunHistoryError } from './chat-run-history'
import type { ChatRunCheckpoint } from './chat-run-types'

function checkpoint(overrides: Partial<ChatRunCheckpoint> = {}): ChatRunCheckpoint {
  return {
    run: {
      id: 'run-1', session_id: 7, user_message_id: 11, assistant_message_id: 12,
      status: 'running', objective: 'write', skill_invocation: null,
      validated_plan: null, capability_snapshot: {}, current_step: 1,
      checkpoint_version: 3, error_data: null,
    },
    steps: [{
      id: 21, run_id: 'run-1', ordinal: 1, status: 'completed',
      assistant_content: [
        { type: 'reasoning', text: 'need to save' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' } },
      ],
      finish_reason: 'tool-calls', usage_data: null,
    }],
    tool_calls: [{
      id: 31, run_id: 'run-1', step_id: 21, tool_call_id: 'call-1',
      tool_name: 'save_draft', input_data: { title: 'one' }, status: 'succeeded',
      approval_id: 'approval-1', approval_decision: { decision: 'approved' },
      output_data: { saved: true, id: 862 }, error_data: null,
      side_effecting: true, replay_policy: 'claim', concurrency_policy: 'serial',
      idempotency_key: 'chat-run:run-1:call-1', tool_version: '1', contract_digest: 'a'.repeat(64),
    }],
    ...overrides,
  }
}

describe('canonical Chat Run model history', () => {
  it('keeps reasoning with its assistant tool call and emits the matching result next', () => {
    const messages = buildCanonicalModelMessages(checkpoint())
    expect(messages).toEqual([
      { role: 'user', content: 'write' },
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'need to save' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'save_draft', input: { title: 'one' } },
      ] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'call-1', toolName: 'save_draft',
        output: { type: 'json', value: { saved: true, id: 862 } },
      }] },
    ])
    expect(messages.every(message => modelMessageSchema.safeParse(message).success)).toBe(true)
  })

  it('reconstructs both save attempts from the session 107 sequence', () => {
    const value = checkpoint({
      steps: [
        {
          id: 21, run_id: 'run-1', ordinal: 1, status: 'completed', assistant_content: [
            { type: 'tool-call', toolCallId: 'call-first', toolName: 'save_draft', input: { title: 'one' } },
          ], finish_reason: 'tool-calls', usage_data: null,
        },
        {
          id: 22, run_id: 'run-1', ordinal: 2, status: 'completed', assistant_content: [
            { type: 'reasoning', text: 'retry with override' },
            { type: 'tool-call', toolCallId: 'call-second', toolName: 'save_draft', input: { override: 'token' } },
          ], finish_reason: 'tool-calls', usage_data: null,
        },
      ],
      tool_calls: [
        { ...checkpoint().tool_calls[0], step_id: 21, tool_call_id: 'call-first', status: 'succeeded', output_data: { saved: false, novelty: 'uncertain' } },
        { ...checkpoint().tool_calls[0], id: 32, step_id: 22, tool_call_id: 'call-second', input_data: { override: 'token' }, status: 'succeeded', output_data: { saved: true, id: 862 } },
      ],
    })

    const messages = buildCanonicalModelMessages(value)

    expect(messages).toHaveLength(5)
    expect(messages[2]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'call-first', output: { type: 'json', value: { saved: false } } }] })
    expect(messages[4]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'call-second', output: { type: 'json', value: { saved: true, id: 862 } } }] })
    expect(messages.every(message => modelMessageSchema.safeParse(message).success)).toBe(true)
  })

  it('rejects a completed tool call without a result before provider execution', () => {
    const value = checkpoint({
      tool_calls: [{ ...checkpoint().tool_calls[0], status: 'approved', output_data: null }],
    })

    expect(() => buildCanonicalModelMessages(value)).toThrowError(
      new ChatRunHistoryError('missing_result', 'Tool call call-1 has no terminal result'),
    )
  })

  it('allows only the current pending approval to omit its result', () => {
    const value = checkpoint({
      run: { ...checkpoint().run, status: 'waiting_approval' },
      steps: [{ ...checkpoint().steps[0], status: 'waiting_approval' }],
      tool_calls: [{ ...checkpoint().tool_calls[0], status: 'pending_approval', output_data: null }],
    })

    expect(buildCanonicalModelMessages(value)).toEqual([
      { role: 'user', content: 'write' },
      { role: 'assistant', content: checkpoint().steps[0].assistant_content },
    ])
  })

  it.each([
    ['duplicate_tool_call', [
      { ...checkpoint().tool_calls[0] },
      { ...checkpoint().tool_calls[0], id: 32 },
    ]],
    ['orphan_result', [
      { ...checkpoint().tool_calls[0], tool_call_id: 'orphan' },
    ]],
    ['invalid_pending_call', [
      { ...checkpoint().tool_calls[0], status: 'pending_approval', output_data: null },
    ]],
  ] as const)('rejects %s checkpoint corruption', (code, tool_calls) => {
    expect(() => buildCanonicalModelMessages(checkpoint({ tool_calls: [...tool_calls] })))
      .toThrowError(expect.objectContaining({ code }))
  })

  it('turns a rejected approval into one provider-compatible denied result', () => {
    const denied = { approved: false, error: 'tool_execution_denied', reason: 'not now' }
    const value = checkpoint({
      run: { ...checkpoint().run, status: 'completed' },
      tool_calls: [{ ...checkpoint().tool_calls[0], status: 'rejected', output_data: denied }],
    })

    expect(buildCanonicalModelMessages(value)[2]).toEqual({
      role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'call-1', toolName: 'save_draft',
        output: { type: 'execution-denied', reason: 'not now' },
      }],
    })
  })
})
