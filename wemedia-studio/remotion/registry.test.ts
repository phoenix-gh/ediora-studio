import { describe, expect, it } from 'vitest'

import { resolveTextVideoTemplate } from './registry'

describe('text-video template registry', () => {
  it('resolves the versioned technology text template', () => {
    expect(resolveTextVideoTemplate('tech-text-v1')).toMatchObject({
      id: 'tech-text-v1',
      version: 1,
    })
  })

  it('rejects unknown template versions', () => {
    expect(() => resolveTextVideoTemplate('tech-text-v2'))
      .toThrow('未知文字视频模板：tech-text-v2')
  })
})
