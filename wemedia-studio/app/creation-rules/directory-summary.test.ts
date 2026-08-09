import { describe, expect, it } from 'vitest'

import { summarizeDirectories } from './directory-summary'

describe('summarizeDirectories', () => {
  it('uses the ordered directory selection and falls back to the legacy field', () => {
    expect(summarizeDirectories(['产品实验', '增长资料'], '')).toBe('产品实验 等 2 个目录')
    expect(summarizeDirectories([], '产品实验')).toBe('产品实验')
  })
})
