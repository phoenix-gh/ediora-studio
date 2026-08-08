import assert from 'node:assert/strict'
import test from 'node:test'

import { findFirst, SELECTORS } from '../content/selectors.js'

function fakeQueryRoot(matches) {
  const root = {
    queries: [],
    querySelector(selector) {
      this.queries.push(selector)
      return matches[selector] || null
    },
  }
  return root
}

test('findFirst returns the first matching fallback', () => {
  const second = { id: 'inline' }
  const root = fakeQueryRoot({ '[data-testid="tweetButtonInline"]': second })

  assert.equal(findFirst(root, SELECTORS.submit), second)
  assert.deepEqual(root.queries, [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
  ])
})

test('selector groups include known compose and scheduler fallbacks', () => {
  assert.deepEqual(SELECTORS.composer, ['[data-testid="tweetTextarea_0"]'])
  assert.equal(SELECTORS.composeTrigger.includes('[data-testid="SideNav_NewTweet_Button"]'), true)
  assert.equal(SELECTORS.schedulerTrigger.includes('[data-testid="scheduleOption"]'), true)
  assert.equal(SELECTORS.schedulerTrigger.includes('[data-testid="scheduledButton"]'), true)
  assert.equal(SELECTORS.scheduleConfirm.includes('[data-testid="scheduledConfirmationPrimaryAction"]'), true)
})
