import { describe, expect, it } from 'vitest'

import { creativeAssetUrl } from './assets'

describe('creative asset URLs', () => {
  it('resolves backend-relative uploaded files for browser media elements', () => {
    expect(creativeAssetUrl('/api/uploads/chat-image.png')).toBe('http://localhost:8000/api/uploads/chat-image.png')
  })

  it('keeps external asset URLs unchanged', () => {
    expect(creativeAssetUrl('https://example.com/image.png')).toBe('https://example.com/image.png')
  })
})
