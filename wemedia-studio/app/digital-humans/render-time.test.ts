import { describe, expect, it } from 'vitest'

import { formatRenderCreatedAt } from './render-time'


describe('render version timestamps', () => {
  it('formats deterministically in the product timezone', () => {
    expect(formatRenderCreatedAt('2026-07-26T13:02:56Z')).toBe(
      '2026/7/26 21:02:56',
    )
  })
})
