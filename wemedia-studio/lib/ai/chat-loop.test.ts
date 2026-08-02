import { describe, expect, it } from 'vitest'

import { CHAT_MAX_STEPS, CHAT_RESEARCH_STEPS, chatToolLoopStep, needsFinalAnswerFallback } from './chat-loop'

describe('global chat tool loop', () => {
  it('reserves the final model step for a user-facing answer', () => {
    expect(CHAT_RESEARCH_STEPS).toBe(4)
    expect(CHAT_MAX_STEPS).toBe(CHAT_RESEARCH_STEPS + 1)
    expect(chatToolLoopStep(0, { referenceCount: 0, readReferenceCount: 0 })).toBeUndefined()
    expect(chatToolLoopStep(CHAT_RESEARCH_STEPS - 1, { referenceCount: 0, readReferenceCount: 0 })).toBeUndefined()
    expect(chatToolLoopStep(CHAT_RESEARCH_STEPS, { referenceCount: 0, readReferenceCount: 0 }))
      .toEqual({ activeTools: [], toolChoice: 'none' })
  })

  it('forces reference reading before an active Skill can use ordinary tools', () => {
    const unread = {
      source: 'manual' as const,
      activeSkillName: 'Alpha',
      referenceCount: 2,
      readReferenceCount: 0,
    }
    expect(chatToolLoopStep(0, unread)).toEqual({
      activeTools: ['readSkillReference'],
      toolChoice: { type: 'tool', toolName: 'readSkillReference' },
    })
    expect(chatToolLoopStep(1, { ...unread, source: 'automatic' })).toEqual({
      activeTools: ['readSkillReference'],
      toolChoice: { type: 'tool', toolName: 'readSkillReference' },
    })
    expect(chatToolLoopStep(1, { ...unread, readReferenceCount: 1 })).toBeUndefined()
  })

  it('detects empty or raw provider tool markup as an invalid final answer', () => {
    expect(needsFinalAnswerFallback('')).toBe(true)
    expect(needsFinalAnswerFallback('<｜｜DSML｜｜tool_calls>')).toBe(true)
    expect(needsFinalAnswerFallback('这是整理后的创作大纲。')).toBe(false)
  })
})
