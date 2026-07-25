import { describe, expect, it } from 'vitest'

import { buildChatInstructions } from './chat-instructions'

describe('buildChatInstructions', () => {
  it('forbids claiming a sensitive action succeeded before approval and tool output', () => {
    expect(buildChatInstructions()).toContain('Do not claim that a sensitive action has succeeded before the user approves it and the tool reports success.')
  })
})
