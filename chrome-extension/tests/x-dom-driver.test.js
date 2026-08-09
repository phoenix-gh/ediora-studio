import assert from 'node:assert/strict'
import test from 'node:test'

import { ERROR_CODES } from '../content/contracts.js'
import {
  createXDomDriver,
  isXHost,
  hasSubmissionEvidence,
  matchesScheduleText,
  setSelectValue,
} from '../content/x-dom-driver.js'
import { SCHEDULE_MEMORY_KEY } from '../content/schedule-memory.js'

test('recognizes only the approved X hosts', () => {
  assert.equal(isXHost('x.com'), true)
  assert.equal(isXHost('twitter.com'), true)
  assert.equal(isXHost('www.x.com'), false)
  assert.equal(isXHost('example.com'), false)
})

test('rejects a non-X page before touching the composer', async () => {
  const document = { querySelector() { throw new Error('must not query') } }
  const driver = createXDomDriver(document, { location: { hostname: 'example.com' } })

  await assert.rejects(driver.assertSupportedPage(), { code: ERROR_CODES.UNSUPPORTED_PAGE })
})

test('accepts submission evidence only from a closed composer or success message', () => {
  assert.equal(hasSubmissionEvidence({ composer: null, successText: '' }), true)
  assert.equal(hasSubmissionEvidence({ composer: {}, successText: '' }), false)
  assert.equal(hasSubmissionEvidence({ composer: {}, successText: 'Your post was sent' }), true)
  assert.equal(hasSubmissionEvidence({ composer: {}, successText: 'Network request finished' }), false)
})

test('sets a schedule select and verifies it through input and change events', () => {
  const events = []
  const select = {
    value: '',
    selectedIndex: -1,
    options: [
      { value: '2026', text: '2026' },
      { value: '2027', text: '2027' },
    ],
    dispatchEvent(event) {
      events.push(event.type)
    },
  }

  setSelectValue(select, 2027, {})

  assert.equal(select.value, '2027')
  assert.deepEqual(events, ['input', 'change'])
})

function rangedSelect(values) {
  const events = []
  return {
    value: '',
    selectedIndex: -1,
    options: values.map(value => ({ value: String(value), text: String(value) })),
    events,
    dispatchEvent(event) {
      events.push(event.type)
    },
  }
}

test('writes all six X schedule selects with the current dialog order', async () => {
  const selects = [
    rangedSelect(Array.from({ length: 12 }, (_, index) => index + 1)),
    rangedSelect(Array.from({ length: 31 }, (_, index) => index + 1)),
    rangedSelect([2026, 2027]),
    rangedSelect(Array.from({ length: 12 }, (_, index) => index + 1)),
    rangedSelect(Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'))),
    rangedSelect(['AM', 'PM']),
  ]
  const dialog = {
    querySelector() { return null },
    querySelectorAll(selector) { return selector === 'select' ? selects : [] },
  }
  const document = {
    querySelector(selector) { return selector === '[role="dialog"]' ? dialog : null },
    querySelectorAll() { return [] },
  }
  const driver = createXDomDriver(document, { location: { hostname: 'x.com' } })

  await driver.setScheduleFields({ year: 2026, month: 8, day: 8, hour12: 8, minute: 30, period: 'PM' })

  assert.deepEqual(selects.map(select => select.value), ['8', '8', '2026', '8', '30', 'PM'])
  assert.deepEqual(selects.map(select => select.events), [
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
  ])
})

test('writes direct X date and time fields when the scheduler exposes them', async () => {
  const dateInput = { value: '', events: [], dispatchEvent(event) { this.events.push(event.type) } }
  const timeInput = { value: '', events: [], dispatchEvent(event) { this.events.push(event.type) } }
  const stored = new Map()
  const dialog = {
    querySelector(selector) {
      if (selector === '[data-testid="scheduledDateField"]') return dateInput
      if (selector === '[data-testid="scheduledTimeField"]') return timeInput
      return null
    },
    querySelectorAll() { return [] },
  }
  const document = {
    querySelector(selector) { return selector === '[role="dialog"]' ? dialog : null },
    querySelectorAll() { return [] },
  }
  const driver = createXDomDriver(document, {
    location: { hostname: 'x.com' },
    localStorage: {
      getItem(key) { return stored.get(key) || null },
      setItem(key, value) { stored.set(key, value) },
    },
  })

  await driver.setScheduleFields({ year: 2026, month: 8, day: 8, hour12: 8, minute: 30, period: 'PM' })

  assert.equal(dateInput.value, '2026-08-08')
  assert.equal(timeInput.value, '20:30')
  assert.deepEqual(dateInput.events, ['input', 'change'])
  assert.deepEqual(timeInput.events, ['input', 'change'])
  assert.equal(stored.has(SCHEDULE_MEMORY_KEY), false)
})

test('uses an enabled submit fallback when the first X button is disabled', async () => {
  const clicked = []
  const disabled = { disabled: true, click() { clicked.push('disabled') } }
  const enabled = { disabled: false, click() { clicked.push('enabled') } }
  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="tweetButton"]') return disabled
      if (selector === '[data-testid="tweetButtonInline"]') return enabled
      return null
    },
  }
  const driver = createXDomDriver(document, { location: { hostname: 'x.com' } })

  await driver.clickFinalSubmit('published')

  assert.deepEqual(clicked, ['enabled'])
})

test('recognizes the requested schedule from visible date and time text', () => {
  const date = new Date(2026, 7, 8, 20, 30)
  assert.equal(matchesScheduleText('Scheduled for Aug 8, 2026 at 8:30 PM', date), true)
  assert.equal(matchesScheduleText('Scheduled for Aug 8, 2026 at 8:00 PM', date), false)
})

test('does not insert content twice when execCommand succeeds', async () => {
  const composer = {
    innerText: '',
    textContent: '',
    focus() {},
    dispatchEvent(event) {
      if (event.type === 'beforeinput') {
        this.textContent += event.data
        this.innerText = this.textContent
      }
    },
  }
  const document = {
    querySelector(selector) {
      return selector === '[data-testid="tweetTextarea_0"]' ? composer : null
    },
    execCommand(command, _showUi, text) {
      if (command !== 'insertText') return false
      composer.textContent += text
      composer.innerText = composer.textContent
      return true
    },
  }
  const driver = createXDomDriver(document, { location: { hostname: 'x.com' } })

  await driver.writeComposerText('hello')

  assert.equal(await driver.readComposerText(), 'hello')
})

test('does not run fallback when execCommand inserted content but returned false', async () => {
  const composer = {
    innerText: '',
    textContent: '',
    focus() {},
    dispatchEvent(event) {
      if (event.type === 'beforeinput') {
        this.textContent += event.data
        this.innerText = this.textContent
      }
    },
  }
  const document = {
    querySelector(selector) {
      return selector === '[data-testid="tweetTextarea_0"]' ? composer : null
    },
    execCommand(command, _showUi, text) {
      if (command !== 'insertText') return false
      composer.textContent += text
      composer.innerText = composer.textContent
      return false
    },
  }
  const driver = createXDomDriver(document, { location: { hostname: 'x.com' } })

  await driver.writeComposerText('hello')

  assert.equal(await driver.readComposerText(), 'hello')
})
