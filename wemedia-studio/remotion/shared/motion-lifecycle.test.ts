import { describe, expect, it } from 'vitest'

import type {
  KineticRenderChunk,
  KineticWordCue,
} from '../types'

import {
  motionLayersAtFrame,
  wordEmphasisProgress,
} from './motion-lifecycle'

function makeChunk(
  overrides: Partial<KineticRenderChunk> = {},
): KineticRenderChunk {
  return {
    id: 'chunk-a',
    start: 0,
    end: 3,
    text: '一段文字',
    motionPreset: 'reveal',
    emphasis: 'normal',
    words: [{
      text: '一段文字',
      start: 0,
      end: 3,
      emphasis: 'normal',
    }],
    ...overrides,
  }
}

describe('motionLayersAtFrame', () => {
  it('keeps the outgoing layer while the next background enters', () => {
    const chunks = [
      makeChunk({ id: 'a', start: 0, end: 3 }),
      makeChunk({ id: 'b', start: 3, end: 6 }),
    ]
    const atBoundary = motionLayersAtFrame(chunks, 90, 30, 6)

    expect(atBoundary.map(layer => layer.chunk.id)).toEqual(['a', 'b'])
    expect(atBoundary[0].exit).toBe(0)
    expect(atBoundary[1].backgroundEnter).toBeGreaterThan(0)
    expect(atBoundary[1].textEnter).toBe(0)
    expect(atBoundary.every(layer => layer.mounted)).toBe(true)
  })

  it.each([24, 30, 60])(
    'uses seconds as the authority at %i FPS',
    (fps) => {
      const chunks = [
        makeChunk({ id: 'a', start: 0, end: 1 }),
        makeChunk({ id: 'b', start: 1, end: 2 }),
      ]

      expect(motionLayersAtFrame(chunks, fps, fps, 6)
        .map(layer => layer.chunk.id)).toEqual(['a', 'b'])
    },
  )

  it('covers frame zero and the final composition frame', () => {
    const chunks = [
      makeChunk({ id: 'a', start: 0, end: 3 }),
      makeChunk({ id: 'b', start: 3, end: 6 }),
    ]

    expect(motionLayersAtFrame(chunks, 0, 30)[0]).toMatchObject({
      index: 0,
      mounted: true,
      exit: 0,
    })
    expect(motionLayersAtFrame(chunks, 179, 30)
      .map(layer => layer.chunk.id)).toEqual(['b'])
    expect(motionLayersAtFrame(chunks, 180, 30)).toEqual([])
  })

  it('mounts a one-frame chunk without invalid progress values', () => {
    const layers = motionLayersAtFrame([
      makeChunk({ start: 0, end: 1 / 30 }),
    ], 0, 30)

    expect(layers).toHaveLength(1)
    for (const value of [
      layers[0].backgroundEnter,
      layers[0].textEnter,
      layers[0].hold,
      layers[0].exit,
    ]) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('returns no layers before frame zero and is deterministic', () => {
    const chunks = [makeChunk()]

    expect(motionLayersAtFrame(chunks, -1, 30)).toEqual([])
    expect(motionLayersAtFrame(chunks, 42, 30))
      .toEqual(motionLayersAtFrame(chunks, 42, 30))
  })
})

describe('wordEmphasisProgress', () => {
  const highlighted: KineticWordCue = {
    text: '没赚到钱',
    start: 1.7,
    end: 2.4,
    emphasis: 'highlight',
  }

  it('fires one deterministic envelope at the spoken cue', () => {
    expect(wordEmphasisProgress(highlighted, 50, 30, 12)).toBe(0)
    expect(wordEmphasisProgress(highlighted, 56, 30, 12))
      .toBeGreaterThan(0)
    expect(wordEmphasisProgress(highlighted, 70, 30, 12)).toBe(0)
    expect(wordEmphasisProgress(highlighted, 56, 30, 12))
      .toBe(wordEmphasisProgress(highlighted, 56, 30, 12))
  })

  it('ignores ordinary or missing cues and negative frames', () => {
    expect(wordEmphasisProgress({
      ...highlighted,
      emphasis: 'normal',
    }, 56, 30)).toBe(0)
    expect(wordEmphasisProgress(undefined, 56, 30)).toBe(0)
    expect(wordEmphasisProgress(highlighted, -1, 30)).toBe(0)
  })
})
