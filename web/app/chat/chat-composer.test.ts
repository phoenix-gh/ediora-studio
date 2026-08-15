import { expect, it } from 'vitest'

import { shouldSubmitChatComposerKey } from './chat-composer'

it('submits the chat composer on Enter without Shift', () => {
  expect(shouldSubmitChatComposerKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
})

it('keeps a newline when Shift and Enter are pressed', () => {
  expect(shouldSubmitChatComposerKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
})

it('does not submit while an input method is composing', () => {
  expect(shouldSubmitChatComposerKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
})
