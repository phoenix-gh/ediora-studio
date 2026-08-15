import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

it('keeps writing templates independent from platform-specific output forms', () => {
  const source = readFileSync(new URL('./WritingPlansClient.tsx', import.meta.url), 'utf8')

  expect(source).not.toContain("{ value: 'x_short', label: 'X 短文' }")
  expect(source).not.toContain("{ value: 'x_thread', label: 'X Thread' }")
  expect(source).not.toContain("{ value: 'wechat_article', label: '公众号文章' }")
  expect(source).toContain('写作模板')
  expect(source).toContain("step.key === 'template_extraction'")
  expect(source).toContain('提炼候选模板')
  expect(source).toContain('confirmCandidate')
})
