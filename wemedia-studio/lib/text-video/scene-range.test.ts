import { describe, expect, it } from 'vitest'

import { sceneFrameRange } from './scene-range'

describe('sceneFrameRange', () => {
  it('converts a selected scene from seconds to an inclusive Player frame range', () => {
    expect(sceneFrameRange({ start: 2.4, end: 4.2 }, 30)).toEqual({
      inFrame: 72,
      outFrame: 125,
    })
  })
})
