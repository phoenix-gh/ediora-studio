import { describe, expect, it } from 'vitest'

import { externalHttpUrl } from './x-post-url'

describe('externalHttpUrl', () => {
  it('keeps only valid HTTP(S) URLs for post links', () => {
    expect(externalHttpUrl('https://x.com/example/status/1')).toBe('https://x.com/example/status/1')
    expect(externalHttpUrl('')).toBeNull()
    expect(externalHttpUrl('javascript:alert(1)')).toBeNull()
    expect(externalHttpUrl(undefined)).toBeNull()
  })
})
