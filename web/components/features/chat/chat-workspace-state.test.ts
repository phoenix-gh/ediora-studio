import { describe, expect, it } from 'vitest'

import type { ChatPart, ChatRole, UIMessageStreamEvent } from '@/lib/api/chat'
import {
  applyChatStreamEvent,
  initialChatStatusPart,
  makeLocalMessage,
  toModelMessages,
} from './chat-workspace-state'
import type { DisplayMessage } from './chat-workspace-types'

function message(
  id: string | number,
  role: ChatRole,
  parts: ChatPart[],
  text = '',
): DisplayMessage {
  return {
    id,
    role,
    parts,
    text,
    created_at: '2026-08-22T00:00:00Z',
  }
}

describe('chat workspace state helpers', () => {
  it('starts a local assistant with a visible thinking status', () => {
    expect(initialChatStatusPart()).toMatchObject({
      type: 'chat-status',
      id: 'chat-activity',
      phase: 'thinking',
      state: 'streaming',
      label: '正在思考',
    })
  })

  it('accumulates reasoning deltas and marks the part complete', () => {
    const assistant = message('assistant-1', 'assistant', [])
    const started = applyChatStreamEvent([assistant], 'assistant-1', {
      type: 'reasoning-start', id: 'r-1',
    })
    const updated = applyChatStreamEvent(started, 'assistant-1', {
      type: 'reasoning-delta', id: 'r-1', delta: '先查资料',
    })
    const ended = applyChatStreamEvent(updated, 'assistant-1', {
      type: 'reasoning-end', id: 'r-1',
    })

    expect(ended[0].parts).toContainEqual({
      type: 'reasoning', id: 'r-1', text: '先查资料', state: 'complete',
    })
  })

  it('only appends a text delta to the targeted assistant message', () => {
    const userMessage = message(1, 'user', [{ type: 'text', text: '问题' }], '问题')
    const assistantMessage = message('assistant-1', 'assistant', [])
    const otherSessionMessage = message('assistant-2', 'assistant', [
      { type: 'text', id: 'text-2', text: '另一个会话' },
    ])
    const event: UIMessageStreamEvent = {
      type: 'text-delta',
      id: 'text-1',
      delta: '你好',
    }

    const next = applyChatStreamEvent(
      [userMessage, assistantMessage, otherSessionMessage],
      'assistant-1',
      event,
    )

    expect(next[1].parts).toEqual(expect.arrayContaining([
      { type: 'text', id: 'text-1', text: '你好' },
      expect.objectContaining({ type: 'chat-status', label: '正在生成回答' }),
    ]))
    expect(next[2]).toEqual(otherSessionMessage)
  })

  it('merges tool start, input, and output by toolCallId', () => {
    const assistantMessage = message('assistant-1', 'assistant', [])
    const withStart = applyChatStreamEvent([assistantMessage], 'assistant-1', {
      type: 'tool-input-start',
      toolCallId: 'call-1',
      toolName: 'searchInformationSources',
    })
    const withInput = applyChatStreamEvent(withStart, 'assistant-1', {
      type: 'tool-input-available',
      toolCallId: 'call-1',
      input: { query: 'AI' },
    })
    const withOutput = applyChatStreamEvent(withInput, 'assistant-1', {
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: { items: [] },
    })

    expect(withOutput[0].parts[0]).toMatchObject({
      type: 'tool-event',
      toolCallId: 'call-1',
      state: 'completed',
      input: { query: 'AI' },
      output: { items: [] },
    })
  })

  it('renders transient Skill status and switches to answer status when text starts', () => {
    const assistantMessage = message('assistant-1', 'assistant', [])
    const withSkill = applyChatStreamEvent([assistantMessage], 'assistant-1', {
      type: 'data-chat-status',
      id: 'chat-activity',
      data: {
        phase: 'skill',
        state: 'streaming',
        label: '正在使用 Skill：去 AI 味',
        skillName: 'humanize-writing',
      },
    })

    expect(withSkill[0].parts).toContainEqual(expect.objectContaining({
      type: 'chat-status',
      phase: 'skill',
      state: 'streaming',
      label: '正在使用 Skill：去 AI 味',
    }))

    const withText = applyChatStreamEvent(withSkill, 'assistant-1', {
      type: 'text-delta',
      id: 'text-1',
      delta: '答案',
    })

    expect(withText[0].parts).toContainEqual(expect.objectContaining({
      type: 'chat-status',
      phase: 'answer',
      state: 'streaming',
      label: '正在生成回答',
    }))
  })

  it('marks the transient status complete when the UI stream finishes', () => {
    const assistantMessage = message('assistant-1', 'assistant', [initialChatStatusPart()])
    const finished = applyChatStreamEvent([assistantMessage], 'assistant-1', {
      type: 'finish',
    })

    expect(finished[0].parts).toContainEqual(expect.objectContaining({
      type: 'chat-status',
      state: 'complete',
      label: '已完成',
    }))
  })

  it('creates a local message and excludes tool-role records from model history', () => {
    const local = makeLocalMessage('user', [{ type: 'text', text: '继续' }])
    const modelMessages = toModelMessages([
      local,
      message(2, 'tool', [{ type: 'tool-result', output: '隐藏' }]),
      message(3, 'assistant', [{ type: 'text', text: '回答' }], '回答'),
    ])

    expect(local).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: '继续' }],
    })
    expect(typeof local.id).toBe('string')
    expect(modelMessages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(modelMessages[0].id).toBe(String(local.id))
  })

  it('keeps existing tool parts when an error event arrives', () => {
    const assistantMessage = message('assistant-1', 'assistant', [{
      type: 'tool-event',
      toolCallId: 'call-1',
      state: 'completed',
      output: { items: ['结果'] },
    }])

    const next = applyChatStreamEvent([assistantMessage], 'assistant-1', {
      type: 'error',
      errorText: 'LLM 请求失败',
    })

    expect(next[0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
      type: 'tool-event',
      toolCallId: 'call-1',
      state: 'completed',
      }),
    ]))
    expect(next[0].parts.at(-1)).toMatchObject({
      type: 'text',
      text: '\nLLM 请求失败',
    })
  })
})
