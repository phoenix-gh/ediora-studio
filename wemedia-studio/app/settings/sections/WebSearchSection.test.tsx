import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

it('saves the SearXNG provider configuration', () => {
  const source = readFileSync(new URL('./WebSearchSection.tsx', import.meta.url), 'utf8')

  expect(source).toContain("key: 'searxng'")
  expect(source).toContain('SearXNG Base URL')
  expect(source).toContain('timeout_seconds')
  expect(source).toContain('web_search_providers')
  expect(source).toContain('保存 Web 搜索设置')
})
