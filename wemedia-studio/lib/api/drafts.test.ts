import { describe, expect, it } from 'vitest'

import { draftTypeInfo } from './drafts'

describe('draftTypeInfo', () => {
  it('shows X and never disguises an unknown marker as an article', () => {
    expect(draftTypeInfo('x').label).toBe('X')
    expect(draftTypeInfo('legacy-platform').label).toBe('legacy-platform')
    expect(draftTypeInfo('legacy-platform').value).toBe('legacy-platform')
  })

  it('uses an explicit unknown label for an empty marker', () => {
    expect(draftTypeInfo('')).toMatchObject({ value: '', label: '未知平台' })
  })
})
