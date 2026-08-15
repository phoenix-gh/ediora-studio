import { describe, expect, it } from 'vitest'

import * as formatters from './format'


describe('date formatting', () => {
  it('formats a timestamp deterministically in Asia/Shanghai time', () => {
    const fmtDateTime = (
      formatters as typeof formatters & {
        fmtDateTime?: (iso: string) => string
      }
    ).fmtDateTime

    expect(fmtDateTime?.('2026-07-25T13:06:07Z')).toBe('2026-07-25 21:06:07')
  })

  it('keeps short and full calendar dates in Asia/Shanghai during UTC SSR', () => {
    const previousTimezone = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      expect(formatters.fmtShortDate('2026-07-25T17:30:00Z')).toBe('7月26日')
      expect(formatters.fmtFullDate('2026-07-25T17:30:00Z')).toBe(
        '2026年7月26日',
      )
    } finally {
      process.env.TZ = previousTimezone
    }
  })
})
