import { describe, expect, it } from 'vitest'

import {
  COMPLETE_GOAL_DESCRIPTION,
  buildRuntimeGoalEvidence,
  goalCompletionFromToolOutput,
} from './agent-goal-completion'

describe('goal completion protocol', () => {
  it('normalizes legacy model evidence without trusting provider tool-call IDs', () => {
    expect(goalCompletionFromToolOutput({
      accepted: true,
      declaration: {
        status: 'completed',
        summary: '素材已经读取',
        evidence: [{
          kind: 'tool_call',
          id: 'get_creative_asset',
          claim: '读取了创作素材',
        }],
      },
    })).toEqual({
      status: 'completed',
      summary: '素材已经读取',
    })
  })

  it('does not ask the Agent to cite transient provider call IDs', () => {
    expect(COMPLETE_GOAL_DESCRIPTION).not.toContain('provider-generated toolCallId')
    expect(COMPLETE_GOAL_DESCRIPTION).not.toContain('exact provider')
  })

  it('builds completion evidence from the actual runtime audit', () => {
    expect(buildRuntimeGoalEvidence([
      {
        toolCallId: 'call_asset_1',
        toolName: 'get_creative_asset',
        status: 'succeeded',
        sideEffecting: false,
      },
      {
        toolCallId: 'goal-1',
        toolName: 'complete_goal',
        status: 'succeeded',
        sideEffecting: false,
      },
    ], [{ kind: 'artifact', id: 'draft-1', claim: '草稿已持久化' }])).toEqual({
      toolCalls: [{
        toolCallId: 'call_asset_1',
        toolName: 'get_creative_asset',
        status: 'succeeded',
        sideEffecting: false,
      }],
      outputs: [{ kind: 'artifact', id: 'draft-1', claim: '草稿已持久化' }],
    })
  })
})
