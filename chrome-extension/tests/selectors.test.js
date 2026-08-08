import assert from 'node:assert/strict'
import test from 'node:test'

import { findFirst, inferScheduleControls, SELECTORS } from '../content/selectors.js'

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

function fakeSelect(options, metadata = {}) {
  return {
    ...metadata,
    options: options.map(option => ({ value: String(option), text: String(option) })),
  }
}

test('infers schedule controls from their option ranges', () => {
  const controls = {
    year: fakeSelect([2025, 2026, 2027]),
    month: fakeSelect(Array.from({ length: 12 }, (_, index) => index + 1)),
    day: fakeSelect(Array.from({ length: 31 }, (_, index) => index + 1)),
    hour: fakeSelect(Array.from({ length: 12 }, (_, index) => index + 1)),
    minute: fakeSelect(Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'))),
    period: fakeSelect(['AM', 'PM']),
  }

  assert.deepEqual(
    Object.fromEntries(Object.entries(inferScheduleControls(Object.values(controls)))
      .map(([kind, element]) => [kind, Object.entries(controls).find(([, candidate]) => candidate === element)?.[0]])),
    { year: 'year', month: 'month', day: 'day', hour: 'hour', minute: 'minute', period: 'period' },
  )
})

test('falls back to X six-select order when option metadata is opaque', () => {
  const controls = Array.from({ length: 6 }, () => fakeSelect(['one', 'two']))
  assert.deepEqual(Object.keys(inferScheduleControls(controls)), [
    'month', 'day', 'year', 'hour', 'minute', 'period',
  ])
  assert.equal(inferScheduleControls(controls).month, controls[0])
  assert.equal(inferScheduleControls(controls).day, controls[1])
  assert.equal(inferScheduleControls(controls).year, controls[2])
  assert.equal(inferScheduleControls(controls).period, controls[5])
})
