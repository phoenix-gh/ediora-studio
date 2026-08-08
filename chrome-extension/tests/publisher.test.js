import assert from 'node:assert/strict'
import test from 'node:test'

import { ERROR_CODES } from '../content/contracts.js'
import { createPublisher } from '../content/publisher.js'

function fakeDriver(options = {}) {
  const driver = {
    calls: [],
    scheduleCalls: [],
    submitted: [],
    composerText: options.composerBefore || '',
    evidenceStarted: null,
    assertSupportedPage: async () => {
      driver.calls.push('assertSupportedPage')
      if (options.unsupported) throw Object.assign(new Error('not an X page'), { code: ERROR_CODES.UNSUPPORTED_PAGE })
    },
    ensureComposer: async () => {
      driver.calls.push('ensureComposer')
      if (options.missingComposer) throw Object.assign(new Error('composer missing'), { code: ERROR_CODES.COMPOSER_NOT_FOUND })
    },
    readComposerText: async () => {
      driver.calls.push('readComposerText')
      return driver.composerText
    },
    writeComposerText: async text => {
      driver.calls.push(['writeComposerText', text])
      driver.composerText = options.composerAfterWrite ?? text
    },
    openScheduler: async () => {
      driver.scheduleCalls.push('openScheduler')
      if (options.schedulerUnavailable) {
        throw Object.assign(new Error('scheduler unavailable'), { code: ERROR_CODES.SCHEDULER_UNAVAILABLE })
      }
    },
    setScheduleFields: async parts => {
      driver.scheduleCalls.push(['setScheduleFields', parts])
      if (options.scheduleControlsChanged) {
        throw Object.assign(new Error('schedule controls changed'), { code: ERROR_CODES.SCHEDULE_CONTROLS_CHANGED })
      }
    },
    confirmScheduleDialog: async () => {
      driver.scheduleCalls.push('confirmScheduleDialog')
    },
    verifyComposerSchedule: async date => {
      driver.scheduleCalls.push(['verifyComposerSchedule', date])
      if (options.scheduleVerified === false) return false
      return true
    },
    clickFinalSubmit: async mode => {
      driver.calls.push(['clickFinalSubmit', mode])
      if (mode === 'scheduled') driver.scheduleCalls.push(['clickFinalSubmit', mode])
      driver.submitted.push(mode)
    },
    waitForSubmissionEvidence: async mode => {
      driver.calls.push(['waitForSubmissionEvidence', mode])
      if (mode === 'scheduled') driver.scheduleCalls.push(['waitForSubmissionEvidence', mode])
      if (options.holdEvidence) {
        driver.evidenceStarted = new Promise(resolve => {
          driver.releaseEvidence = () => resolve(options.evidence !== false)
        })
        return driver.evidenceStarted
      }
      return options.evidence !== false
    },
  }
  return driver
}

test('publishes only after text round-trip verification', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'hello', evidence: true })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })

  assert.deepEqual(await publish({ text: 'hello' }), { ok: true, action: 'published' })
  assert.deepEqual(driver.calls, [
    'assertSupportedPage',
    'ensureComposer',
    'readComposerText',
    ['writeComposerText', 'hello'],
    'readComposerText',
    ['clickFinalSubmit', 'published'],
    ['waitForSubmissionEvidence', 'published'],
  ])
})

test('dry run never submits', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'hello' })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })

  assert.deepEqual(await publish({ text: 'hello', dryRun: true }), { ok: true, action: 'dry-run' })
  assert.equal(driver.submitted.length, 0)
})

test('protects an existing non-empty composer', async () => {
  const driver = fakeDriver({ composerBefore: 'existing draft' })
  const publish = createPublisher({ driver })

  const result = await publish({ text: 'new post' })

  assert.equal(result.error.code, ERROR_CODES.EXISTING_DRAFT)
  assert.equal(driver.calls.includes('writeComposerText'), false)
})

test('returns a mismatch error without submitting', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'different' })
  const publish = createPublisher({ driver })

  const result = await publish({ text: 'hello' })

  assert.equal(result.error.code, ERROR_CODES.TEXT_MISMATCH)
  assert.equal(driver.submitted.length, 0)
})

test('returns unconfirmed submit errors without retrying the button', async () => {
  const driver = fakeDriver({ composerBefore: '', evidence: false })
  const publish = createPublisher({ driver })

  const result = await publish({ text: 'hello' })

  assert.equal(result.error.code, ERROR_CODES.SUBMIT_NOT_CONFIRMED)
  assert.deepEqual(driver.submitted, ['published'])
})

test('returns BUSY while the first publish is awaiting evidence', async () => {
  const driver = fakeDriver({ composerBefore: '', holdEvidence: true })
  const publish = createPublisher({ driver })

  const first = publish({ text: 'first' })
  while (!driver.evidenceStarted) await new Promise(resolve => setImmediate(resolve))
  const second = await publish({ text: 'second' })
  driver.releaseEvidence()

  assert.equal(second.error.code, ERROR_CODES.BUSY)
  assert.deepEqual(await first, { ok: true, action: 'published' })
})

test('sets, verifies, and finally submits an X-native schedule', async () => {
  const driver = fakeDriver({
    composerBefore: '',
    composerAfterWrite: 'later',
    evidence: true,
    scheduleVerified: true,
  })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })

  const result = await publish({ text: 'later', scheduledAt: '2026-08-08 20:30' })

  assert.equal(result.ok, true)
  assert.equal(result.action, 'scheduled')
  assert.match(result.scheduledAt, /^2026-08-08T20:30:00[+-]\d{2}:\d{2}$/)
  assert.deepEqual(driver.scheduleCalls, [
    'openScheduler',
    ['setScheduleFields', { year: 2026, month: 8, day: 8, hour12: 8, minute: 30, period: 'PM' }],
    'confirmScheduleDialog',
    ['verifyComposerSchedule', new Date(2026, 7, 8, 20, 30)],
    ['clickFinalSubmit', 'scheduled'],
    ['waitForSubmissionEvidence', 'scheduled'],
  ])
})

test('scheduled dry run configures X but never submits', async () => {
  const driver = fakeDriver({ composerBefore: '', composerAfterWrite: 'later', scheduleVerified: true })
  const publish = createPublisher({ driver, now: () => new Date(2026, 7, 8, 10, 0) })

  const result = await publish({
    text: 'later',
    scheduledAt: '2026-08-08T20:30',
    dryRun: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.action, 'dry-run')
  assert.match(result.scheduledAt, /^2026-08-08T20:30:00[+-]\d{2}:\d{2}$/)
  assert.equal(driver.submitted.length, 0)
  assert.equal(driver.scheduleCalls.some(call => Array.isArray(call) && call[0] === 'clickFinalSubmit'), false)
})

test('maps scheduler control and verification failures without submitting', async () => {
  const unavailable = fakeDriver({ schedulerUnavailable: true })
  const publishUnavailable = createPublisher({ driver: unavailable })
  assert.equal((await publishUnavailable({ text: 'later', scheduledAt: '2099-08-08 20:30' })).error.code, ERROR_CODES.SCHEDULER_UNAVAILABLE)

  const mismatch = fakeDriver({ scheduleVerified: false })
  const publishMismatch = createPublisher({ driver: mismatch })
  assert.equal((await publishMismatch({ text: 'later', scheduledAt: '2099-08-08 20:30' })).error.code, ERROR_CODES.SCHEDULE_CONTROLS_CHANGED)
  assert.equal(mismatch.submitted.length, 0)
})
