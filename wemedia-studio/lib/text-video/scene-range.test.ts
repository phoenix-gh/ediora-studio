import { describe, expect, it } from 'vitest'

import { sceneFrameRange } from './scene-range'

describe('sceneFrameRange', () => {
  it('converts a selected scene from seconds to an inclusive Player frame range', () => {
    expect(sceneFrameRange({ start: 2.4, end: 4.2 }, 30)).toEqual({
      inFrame: 72,
      outFrame: 125,
    })
  })

  it('ceil-aligns a fractional start so the previous scene never flashes', () => {
    expect(sceneFrameRange({ start: 2.4001, end: 4.2 }, 30)).toEqual({
      inFrame: 73,
      outFrame: 125,
    })
  })

  it('keeps adjacent and full-film boundaries on one inclusive frame model', () => {
    const first = sceneFrameRange({ start: 0, end: 2.4001 }, 30)
    const second = sceneFrameRange({ start: 2.4001, end: 4.2 }, 30)

    expect(first).toEqual({ inFrame: 0, outFrame: 72 })
    expect(second.inFrame).toBe(first.outFrame + 1)
    expect(second.outFrame).toBe(Math.ceil(4.2 * 30) - 1)
  })
})
