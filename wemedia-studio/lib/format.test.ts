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
})
