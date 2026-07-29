import { describe, expect, it } from 'vitest'

import { parseTextVideoRenderInput } from './contract'

const validInput = {
  templateId: 'tech-text-v1',
  templateVersion: 1,
  composition: {
    width: 1080,
    height: 1920,
    fps: 30,
  },
  audio: 'voice.mp3',
  segments: [
    {
      id: 'scene-1',
      start: 0,
      end: 2.4,
      text: '做 AI 视频的',
      highlight: [],
      animation: 'fade-up',
    },
    {
      id: 'scene-2',
      start: 2.4,
      end: 4.2,
      text: '一个月没赚到钱',
      highlight: ['没赚到钱'],
      animation: 'scale',
    },
  ],
  templateProps: {
    theme: 'tech-blue',
    font: 'source-han-sans',
    background: 'dark-grid',
    transition: 'soft-push',
    textDensity: 'standard',
  },
}

describe('text-video render contract', () => {
  it('accepts a valid, ordered render input', () => {
    expect(parseTextVideoRenderInput(validInput)).toEqual(validInput)
  })

  it('rejects overlapping segments', () => {
    expect(() => parseTextVideoRenderInput({
      ...validInput,
      segments: [
        validInput.segments[0],
        { ...validInput.segments[1], start: 2.3 },
      ],
    })).toThrow('segments must be ordered and non-overlapping')
  })

  it('accepts only the supported 9:16, 16:9, and 1:1 aspect ratios', () => {
    expect(() => parseTextVideoRenderInput({
      ...validInput,
      composition: { ...validInput.composition, width: 1920, height: 1080 },
    })).not.toThrow()
    expect(() => parseTextVideoRenderInput({
      ...validInput,
      composition: { ...validInput.composition, width: 1080, height: 1080 },
    })).not.toThrow()
    expect(() => parseTextVideoRenderInput({
      ...validInput,
      composition: { ...validInput.composition, width: 1200, height: 900 },
    })).toThrow('composition must use a supported aspect ratio')
  })
})
