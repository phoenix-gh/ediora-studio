import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

it('configures ordered fetch providers in the settings UI', () => {
  const source = readFileSync(new URL('./WebFetchSection.tsx', import.meta.url), 'utf8')

  expect(source).toContain("key: 'direct'")
  expect(source).toContain("key: 'jina_reader'")
  expect(source).toContain("key: 'camofox'")
  expect(source).toContain('web_fetch_providers')
})
