import { describe, expect, it } from 'vitest'

import { isChatToolPart } from './chat-tool-parts'

describe('isChatToolPart', () => {
  it('recognizes persisted AI SDK dynamic tool calls', () => {
    expect(isChatToolPart({ type: 'dynamic-tool' })).toBe(true)
  })

  it.each(['tool-event', 'tool-result', 'tool-fetch_url'])(
    'preserves support for %s',
    type => expect(isChatToolPart({ type })).toBe(true),
  )

  it.each(['text', 'step-start'])(
    'does not classify %s as tool activity',
    type => expect(isChatToolPart({ type })).toBe(false),
  )
})
