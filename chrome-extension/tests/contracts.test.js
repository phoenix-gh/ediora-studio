import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ERROR_CODES,
  formatLocalIso,
  parseLocalSchedule,
  validatePublishRequest,
} from '../content/contracts.js'

test('accepts immediate and local scheduled requests', () => {
  const now = new Date(2026, 7, 8, 10, 0)

  assert.deepEqual(validatePublishRequest({ text: '  hello  ' }, now), {
    text: 'hello',
    dryRun: false,
    scheduledAt: null,
  })

  const request = validatePublishRequest({
    text: 'scheduled',
    scheduledAt: '2026-08-08 20:30',
    dryRun: true,
  }, now)

  assert.equal(request.scheduledAt.getTime(), new Date(2026, 7, 8, 20, 30).getTime())
  assert.equal(request.dryRun, true)
})

test('rejects empty, malformed, timezone-suffixed, and past requests', () => {
  const now = new Date(2026, 7, 8, 10, 0)

  assert.throws(() => validatePublishRequest({ text: ' ' }, now), {
    code: ERROR_CODES.EMPTY_TEXT,
  })
  assert.throws(() => parseLocalSchedule('2026-08-08T20:30:00', now), {
    code: ERROR_CODES.INVALID_SCHEDULE_TIME,
  })
  assert.throws(() => parseLocalSchedule('2026-08-08T20:30+08:00', now), {
    code: ERROR_CODES.INVALID_SCHEDULE_TIME,
  })
  assert.throws(() => parseLocalSchedule('2026-08-08 09:59', now), {
    code: ERROR_CODES.SCHEDULE_TIME_IN_PAST,
  })
})

test('formats a local datetime with its actual timezone offset', () => {
  assert.match(
    formatLocalIso(new Date(2026, 7, 8, 20, 30)),
    /^2026-08-08T20:30:00[+-]\d{2}:\d{2}$/,
  )
})
