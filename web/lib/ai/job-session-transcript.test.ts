import { describe, expect, it } from 'vitest'

import type { AgentSessionEvent } from './agent-trajectory'
import { buildJobSession } from './job-session-transcript'

function event(partial: Pick<AgentSessionEvent, 'seq' | 'type' | 'data'>): AgentSessionEvent {
  return { time: partial.seq, turn: 1, step: 1, ...partial }
}

describe('job session transcript', () => {
  it('shows the task, the reply, and the tool failure in order', () => {
    const entries = buildJobSession([
      event({ seq: 1, type: 'turn/start', data: { turn: 1 } }),
      event({ seq: 2, type: 'user/message', data: { content: [{ kind: 'text', text: '生成人像' }] } }),
      event({ seq: 3, type: 'assistant/message', data: { blocks: [{ kind: 'reasoning', text: '先查目录' }, { kind: 'text', text: '开始生图' }] } }),
      event({ seq: 4, type: 'tool/call', data: { callId: 'call-1', name: 'ediora/generateImage', arguments: { prompt: 'apple' } } }),
      event({ seq: 5, type: 'tool/result', data: { callId: 'call-1', isError: true, error: 'approval policy is never' } }),
      event({ seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } }),
    ])

    expect(entries.map(entry => entry.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(entries[1]).toMatchObject({ text: '开始生图', reasoning: '先查目录' })
    expect(entries[2]).toMatchObject({
      title: 'ediora/generateImage',
      failed: true,
      error: 'approval policy is never',
    })
  })
})
