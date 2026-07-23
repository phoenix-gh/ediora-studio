import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { chatComposerColumn, chatContentColumn, chatConversationColumn } from './chat-layout'

it('uses one centered responsive column for chat content', () => {
  expect(chatContentColumn).toContain('mx-auto')
  expect(chatContentColumn).toContain('max-w-4xl')
  expect(chatConversationColumn).toContain('px-4')
  expect(chatConversationColumn).toContain('sm:px-6')
})

it('aligns the composer text with the message body after its avatar gutter', () => {
  expect(chatConversationColumn).toContain('px-4')
  expect(chatConversationColumn).toContain('sm:px-6')
  expect(chatComposerColumn).toContain('pl-12')
  expect(chatComposerColumn).toContain('sm:pl-14')
})

it('uses the shared column in both conversation and composer regions', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source.match(/chatConversationColumn/g)).toHaveLength(3)
  expect(source.match(/chatComposerColumn/g)).toHaveLength(2)
})
