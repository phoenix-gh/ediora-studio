// Reserve one model step to turn tool results into a response. Without this,
// a model that keeps researching can reach streamText's stop condition with
// no user-facing text at all.
export const CHAT_RESEARCH_STEPS = 3
export const CHAT_MAX_STEPS = CHAT_RESEARCH_STEPS + 1

export function chatToolLoopStep(stepNumber: number) {
  return stepNumber >= CHAT_RESEARCH_STEPS ? { toolChoice: 'none' as const } : undefined
}

export function needsFinalAnswerFallback(text: string) {
  return !text.trim() || /tool_calls|<｜｜DSML｜｜/i.test(text)
}
