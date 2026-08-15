import { describe, expect, it } from 'vitest'

import { buildChatInstructions } from './chat-instructions'

describe('buildChatInstructions', () => {
  it('forbids claiming a sensitive action succeeded before approval and tool output', () => {
    expect(buildChatInstructions()).toContain('Do not claim that a sensitive action has succeeded before the user approves it and the tool reports success.')
  })

  it('explains metadata-only automatic Skill activation without preloading instructions', () => {
    const instructions = buildChatInstructions('Enabled Skills available for automatic activation:\n- Alpha: Writes alpha copy')

    expect(instructions).toContain('Enabled Skills available for automatic activation:')
    expect(instructions).toContain('loadSkill')
    expect(instructions).toContain('at most one')
  })
})
