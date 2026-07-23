import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { chatContentColumn } from './chat-layout'

it('uses one centered responsive column for chat content', () => {
  expect(chatContentColumn).toContain('mx-auto')
  expect(chatContentColumn).toContain('max-w-4xl')
  expect(chatContentColumn).toContain('px-4')
  expect(chatContentColumn).toContain('sm:px-6')
})

it('uses the shared column in both conversation and composer regions', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source.match(/chatContentColumn/g)).toHaveLength(4)
})
