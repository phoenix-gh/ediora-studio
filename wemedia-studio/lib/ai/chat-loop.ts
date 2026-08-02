import type { ChatSkillSnapshot } from './global-chat-tools'

// Reserve one model step to turn tool results into a response. Without this,
// a model that keeps researching can reach streamText's stop condition with
// no user-facing text at all.
export const CHAT_RESEARCH_STEPS = 4
export const CHAT_MAX_STEPS = CHAT_RESEARCH_STEPS + 1

export function chatToolLoopStep(stepNumber: number, skill: ChatSkillSnapshot) {
  if (stepNumber >= CHAT_RESEARCH_STEPS) return { activeTools: [], toolChoice: 'none' as const }
  if (skill.activeSkillName && skill.referenceCount > 0 && skill.readReferenceCount === 0) {
    return {
      activeTools: ['readSkillReference'],
      toolChoice: { type: 'tool' as const, toolName: 'readSkillReference' },
    }
  }
  return undefined
}

export function needsFinalAnswerFallback(text: string) {
  return !text.trim() || /tool_calls|<｜｜DSML｜｜/i.test(text)
}
