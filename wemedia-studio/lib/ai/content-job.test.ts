import { describe, expect, it } from 'vitest'

import { toolsForContentStep } from './content-job'

describe('content job tool allowlist', () => {
  it('limits draft orchestration to declared tools', () => {
    expect(toolsForContentStep('draft')).toEqual([
      'getBrief',
      'loadWritingContext',
      'saveDraft',
    ])
  })
})
