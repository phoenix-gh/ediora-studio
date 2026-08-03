import { expect, it } from 'vitest'

import { summarizeDirectories } from './directory-summary'

it('summarizes current and legacy directory selections', () => {
  expect(summarizeDirectories(['甲', '乙', '丙'])).toBe('甲、乙、丙')
  expect(summarizeDirectories(['甲', '乙', '丙', '丁'])).toBe('甲、乙、丙等 4 个目录')
  expect(summarizeDirectories([], '旧目录')).toBe('旧目录')
})
