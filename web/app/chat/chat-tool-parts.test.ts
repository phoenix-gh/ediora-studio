import { describe, expect, it } from 'vitest'

import { generatedImageUrls, isChatToolPart, legacyImageJobId } from './chat-tool-parts'

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

describe('generatedImageUrls', () => {
  it('reads the saved asset from a direct generateImage result', () => {
    expect(generatedImageUrls({
      type: 'dynamic-tool',
      toolName: 'generateImage',
      output: {
        asset_id: 12,
        asset_url: '/api/uploads/chat.png',
        title: 'Chat 生图',
      },
    })).toEqual(['http://localhost:8000/api/uploads/chat.png'])
  })

  it('ignores non-image tools and empty outputs', () => {
    expect(generatedImageUrls({ type: 'dynamic-tool', toolName: 'search_web', output: { asset_url: '/api/uploads/x.png' } })).toEqual([])
    expect(generatedImageUrls({ type: 'dynamic-tool', toolName: 'generateImage' })).toEqual([])
  })
})

describe('legacyImageJobId', () => {
  it('keeps older job-based generateImage previews working', () => {
    expect(legacyImageJobId({ type: 'dynamic-tool', toolName: 'generateImage', output: { jobId: 44 } })).toBe(44)
    expect(legacyImageJobId({ type: 'dynamic-tool', toolName: 'generateImage', output: { asset_url: '/api/uploads/chat.png' } })).toBeNull()
  })
})
