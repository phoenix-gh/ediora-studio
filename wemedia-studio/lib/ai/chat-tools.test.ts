import { describe, expect, it } from 'vitest'

import { chatToolNames, makeChatTools, searchInformationSourcesSchema } from './chat-tools'

describe('global chat source tools', () => {
  it('exposes only the two declared read-only source tools', () => {
    const tools = makeChatTools({ apiBase: 'http://localhost:8000/api', sessionId: 42 })

    expect(Object.keys(tools)).toEqual([
      'searchInformationSources',
      'readInformationSource',
    ])
    expect(chatToolNames).toEqual([
      'searchInformationSources',
      'readInformationSource',
    ])
  })

  it('caps source search results at twenty', () => {
    expect(searchInformationSourcesSchema.parse({ q: 'AI', limit: 20 })).toEqual({
      q: 'AI',
      limit: 20,
    })
    expect(() => searchInformationSourcesSchema.parse({ q: 'AI', limit: 21 })).toThrow()
  })
})
