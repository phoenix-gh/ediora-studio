import { expect, it } from 'vitest'

import { normalizeRunDirectories } from './daily-creation-job'

it('uses current directory lists and falls back to a legacy directory', () => {
  expect(normalizeRunDirectories({
    directories: ['目录甲', '目录乙'], directory: '旧目录',
  })).toEqual(['目录甲', '目录乙'])
  expect(normalizeRunDirectories({ directory: '旧目录' })).toEqual(['旧目录'])
  expect(() => normalizeRunDirectories({ directories: [], directory: '' }))
    .toThrow(/at least one directory/i)
})
