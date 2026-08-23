import { describe, expect, it } from 'vitest'

import { validateGoalCompletionEvidence } from './agent-goal-completion'

describe('goal completion evidence', () => {
  it('rejects a tool name and reports the exact successful tool call ID', () => {
    expect(() => validateGoalCompletionEvidence({
      status: 'completed',
      summary: '素材已经读取',
      evidence: [{
        kind: 'tool_call',
        id: 'get_creative_asset',
        claim: '读取了创作素材',
      }],
    }, [{
      toolCallId: 'call_asset_1',
      toolName: 'get_creative_asset',
      status: 'succeeded',
    }])).toThrow(
      'Goal completion cites an unavailable tool call: get_creative_asset. Available successful tool calls: call_asset_1 (get_creative_asset)',
    )
  })
})
