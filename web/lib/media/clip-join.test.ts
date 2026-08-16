import { describe, expect, it } from 'vitest'

import {
  buildHardCutFilter,
  lastFrameExtractArgs,
  parseSilenceWindows,
  speechBounds,
} from './clip-join'


describe('clip join helpers', () => {
  it('trims leading and trailing hush without eating mid-sentence pauses', () => {
    const stderr = [
      'silence_start: 0',
      'silence_end: 0.785687 | silence_duration: 0.785687',
      'silence_start: 8.26375',
      'silence_end: 9.58075 | silence_duration: 1.317',
      'silence_start: 12.9597',
      'silence_end: 15.104 | silence_duration: 2.14425',
    ].join('\n')
    const windows = parseSilenceWindows(stderr)
    const bounds = speechBounds(15.083, windows)
    expect(bounds.start).toBeCloseTo(0.706, 2)
    expect(bounds.end).toBeCloseTo(13.04, 2)
  })

  it('keeps the clip when speech would become too short', () => {
    const bounds = speechBounds(1.2, [
      { start: 0, end: 0.7 },
      { start: 0.9, end: 1.2 },
    ])
    expect(bounds).toEqual({ start: 0, end: 1.2 })
  })

  it('hard-cuts video and audio on the same timeline', () => {
    expect(buildHardCutFilter(1)).toBe('[0:v]copy[v];[0:a]acopy[a]')
    expect(buildHardCutFilter(3)).toBe(
      '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]',
    )
    expect(buildHardCutFilter(3)).not.toContain('acrossfade')
  })

  it('seeks the last video frame instead of a mid-speech still', () => {
    expect(lastFrameExtractArgs('/tmp/in.mp4', '/tmp/frame.jpg')).toEqual([
      '-y',
      '-sseof',
      '-0.04',
      '-i',
      '/tmp/in.mp4',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '/tmp/frame.jpg',
    ])
  })
})
