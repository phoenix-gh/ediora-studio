import { describe, expect, it } from 'vitest'

import {
  deriveAgentTrajectory,
  mergeAgentSessionEvents,
  trajectoryRecordId,
  type AgentSessionEvent,
} from './agent-trajectory'

function event(
  seq: number,
  type: AgentSessionEvent['type'],
  data: Record<string, unknown> = {},
  turn: number | null = 1,
  step: number | null = null,
): AgentSessionEvent {
  return { seq, time: seq * 1_000, type, turn, step, data }
}

describe('Agent trajectory projection', () => {
  it('folds user, assistant blocks, and paired tool result into turn and step groups', () => {
    const snapshot = deriveAgentTrajectory([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'user/message', {
        content: [{ kind: 'text', text: '查一下 AI 趋势' }],
        source: { kind: 'user' },
      }),
      event(3, 'step/start', { turn: 1, step: 1 }, 1, 1),
      event(4, 'assistant/message', {
        turn: 1,
        step: 1,
        blocks: [
          { kind: 'reasoning', text: '先检索资料' },
          { kind: 'tool-call', callId: 'call-1', name: 'search', argsRaw: '{"q":"AI"}' },
        ],
        usage: { inputTokens: 12, outputTokens: 8 },
        timing: { stepStartTime: 3_000, firstTokenTime: 3_100, completedTime: 4_000 },
      }, 1, 1),
      event(5, 'tool/result', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        content: [{ kind: 'text', text: '找到 2 条资料' }],
        isError: false,
      }, 1, 1),
      event(6, 'step/end', { turn: 1, step: 1 }, 1, 1),
      event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(snapshot.turns).toHaveLength(1)
    expect(snapshot.turns[0]?.groups.map(group => group.title)).toEqual(['Message', 'Step 1'])
    const cells = snapshot.turns[0]?.groups.flatMap(group => group.cells) ?? []
    expect(cells.map(cell => cell.kind)).toEqual(['user', 'message', 'tool'])
    expect(cells.find(cell => cell.kind === 'message')).toMatchObject({
      thinkingDetail: '先检索资料',
      usage: { inputTokens: 12, outputTokens: 8 },
    })
    expect(cells.find(cell => cell.callId === 'call-1')).toMatchObject({
      kind: 'tool',
      toolName: 'search',
      inputDetail: '{"q":"AI"}',
      outputDetail: '找到 2 条资料',
      status: 'completed',
      timeSeconds: 2,
    })
    expect(snapshot.isRunning).toBe(false)
  })

  it('keeps an unmatched tool call as a running record without fabricating duration', () => {
    const snapshot = deriveAgentTrajectory([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }, 1, 1),
      event(3, 'tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-running',
        name: 'search',
        arguments: '{"q":"AI"}',
      }, 1, 1),
    ])

    expect(snapshot.isRunning).toBe(true)
    expect(snapshot.runningCalls).toHaveLength(1)
    expect(snapshot.runningCalls[0]).toMatchObject({ callId: 'call-running', status: 'running', timeSeconds: null })
    expect(snapshot.runningCalls[0]?.inputDetail).toBe('{"q":"AI"}')
  })

  it('folds raw assistant chunks into a stable partial and removes it after completion', () => {
    const partial = deriveAgentTrajectory([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }, 1, 1),
      event(3, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { kind: 'reasoning', text: '思考中' },
      }, 1, 1),
      event(4, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { kind: 'text', text: '答案' },
      }, 1, 1),
    ])

    expect(partial.partial).toMatchObject({
      recordId: 'partial:1:1',
      thinkingDetail: '思考中',
      text: '答案',
      status: 'running',
      timeSeconds: null,
    })
    expect(partial.turns.flatMap(turn => turn.groups.flatMap(group => group.cells))).toContainEqual(expect.objectContaining({
      recordId: 'partial:1:1', status: 'running', text: '答案', thinkingDetail: '思考中',
    }))
    const firstId = partial.partial ? trajectoryRecordId(partial.partial) : null

    const completed = deriveAgentTrajectory([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'step/start', { turn: 1, step: 1 }, 1, 1),
      event(3, 'assistant/chunk', { turn: 1, step: 1, chunk: { kind: 'text', text: '答案' } }, 1, 1),
      event(4, 'assistant/message', {
        turn: 1,
        step: 1,
        blocks: [{ kind: 'text', text: '答案' }],
      }, 1, 1),
    ])

    expect(completed.partial).toBeNull()
    expect(completed.turns.flatMap(turn => turn.groups.flatMap(group => group.cells))).toContainEqual(expect.objectContaining({
      recordId: 'partial:1:1', status: 'completed', text: '答案',
    }))
    expect(firstId).toBe('partial:1:1')
  })

  it('exposes typed turn errors and keeps record IDs stable across cursor merges', () => {
    const initial = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { kind: 'text', text: '部分' } }, 1, 1),
    ]
    const merged = mergeAgentSessionEvents(initial, [
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { kind: 'text', text: '部分' } }, 1, 1),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'error', error: '模型接口失败' } }),
    ])
    expect(merged.map(item => item.seq)).toEqual([1, 2, 3])
    expect(deriveAgentTrajectory(merged)).toMatchObject({
      isRunning: false,
      lastError: { kind: 'error', message: '模型接口失败' },
    })
  })
})
