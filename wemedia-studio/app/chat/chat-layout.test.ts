import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { chatComposerColumn, chatContentColumn, chatConversationColumn } from './chat-layout'

it('uses one centered responsive column for chat content', () => {
  expect(chatContentColumn).toContain('mx-auto')
  expect(chatContentColumn).toContain('max-w-4xl')
  expect(chatConversationColumn).toContain('px-4')
  expect(chatConversationColumn).toContain('sm:px-6')
})

it('uses the same column for messages and the avatar-free composer', () => {
  expect(chatConversationColumn).toContain('px-4')
  expect(chatConversationColumn).toContain('sm:px-6')
  expect(chatComposerColumn).toBe(chatConversationColumn)
})

it('uses the shared column in both conversation and composer regions', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source.match(/chatConversationColumn/g)).toHaveLength(3)
  expect(source.match(/chatComposerColumn/g)).toHaveLength(2)
})

it('does not render message avatars', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).not.toContain('<span className="text-xs font-semibold">我</span>')
  expect(source).not.toContain('<Bot className="h-4 w-4" />')
})

it('renders assistant replies at the full message-column width', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain("isUser ? 'min-w-0 max-w-3xl space-y-2' : 'w-full min-w-0 space-y-2'")
})

it('uses a white workspace and borderless assistant replies', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('flex h-full min-h-0 bg-white dark:bg-zinc-950')
  expect(source).toContain("? 'rounded-tr-sm bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'\n              : 'text-zinc-800 dark:text-zinc-100'")
})
