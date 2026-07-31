// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TextVideoRenderInput } from '../../types'
import { KineticPunchV2Composition } from './Composition'
import {
  KINETIC_PUNCH_V2_DEFAULTS,
  type KineticPunchV2Props,
} from './config'
import { kineticLayout } from './layout'

let currentFrame = 90

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>()
  return {
    ...actual,
    Html5Audio: ({ src }: { src: string }) => (
      <audio data-testid="kinetic-audio" src={src} />
    ),
    useCurrentFrame: () => currentFrame,
    useVideoConfig: () => ({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 180,
      id: 'kinetic-punch-v2',
      defaultProps: {},
      props: {},
    }),
  }
})

const INPUT: TextVideoRenderInput<KineticPunchV2Props> = {
  templateId: 'kinetic-punch-v2',
  templateVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30 },
  audio: 'voice.mp3',
  segments: [{
    id: 'scene-1',
    start: 0,
    end: 6,
    text: '旧观点新结论',
    highlight: ['新结论'],
    animation: 'reveal',
    transition: 'block-wipe',
    intensity: 0.8,
    chunks: [
      {
        id: 'chunk-a',
        start: 0,
        end: 3,
        text: '旧观点',
        motionPreset: 'reveal',
        emphasis: 'normal',
        words: [{
          text: '旧观点',
          start: 0,
          end: 3,
          emphasis: 'normal',
        }],
      },
      {
        id: 'chunk-b',
        start: 3,
        end: 6,
        text: '新结论',
        motionPreset: 'impact',
        emphasis: 'punch',
        words: [{
          text: '新结论',
          start: 3.2,
          end: 4,
          emphasis: 'highlight',
        }],
      },
    ],
  }],
  templateProps: KINETIC_PUNCH_V2_DEFAULTS,
}

describe('kineticLayout', () => {
  it.each([
    [1080, 1920],
    [1920, 1080],
    [1080, 1080],
  ])('returns bounded responsive geometry for %ix%i', (width, height) => {
    const layout = kineticLayout(width, height, 12)

    expect(layout.maxLines).toBe(3)
    expect(layout.fontSize).toBeGreaterThan(0)
    expect(layout.maxTextWidth).toBeLessThan(width)
    expect(layout.safeInsetX).toBeGreaterThan(0)
    expect(layout.safeInsetY).toBeGreaterThan(0)
  })

  it('reduces type size as visible copy grows', () => {
    expect(kineticLayout(1080, 1920, 20).fontSize)
      .toBeLessThan(kineticLayout(1080, 1920, 8).fontSize)
  })
})

describe('KineticPunchV2Composition', () => {
  it('keeps both layers mounted at a chunk boundary without blanking', () => {
    currentFrame = 90
    const view = render(<KineticPunchV2Composition {...INPUT} />)

    expect(view.getByTestId('kinetic-layer-chunk-a')).toBeInTheDocument()
    expect(view.getByTestId('kinetic-layer-chunk-b')).toBeInTheDocument()
    expect(view.getByTestId('kinetic-text-chunk-a')).not.toHaveStyle({
      opacity: '0',
    })
    expect(view.getByTestId('kinetic-text-chunk-b')).toHaveStyle({
      opacity: '0',
    })
    expect(view.getByTestId('kinetic-audio')).toHaveAttribute(
      'src',
      'voice.mp3',
    )
  })

  it('does not reveal incoming text before its spoken chunk time', () => {
    currentFrame = 88
    const view = render(<KineticPunchV2Composition {...INPUT} />)

    expect(view.getByTestId('kinetic-layer-chunk-b')).toBeInTheDocument()
    expect(view.getByTestId('kinetic-text-chunk-b')).toHaveStyle({
      opacity: '0',
    })
  })

  it('enlarges highlighted copy during its spoken cue', () => {
    currentFrame = 96
    const before = render(<KineticPunchV2Composition {...INPUT} />)
    const beforeTransform = before.getByTestId('kinetic-highlight-chunk-b')
      .style.transform
    before.unmount()

    currentFrame = 102
    const active = render(<KineticPunchV2Composition {...INPUT} />)
    const activeTransform = active.getByTestId('kinetic-highlight-chunk-b')
      .style.transform

    expect(beforeTransform).toContain('scale(1)')
    expect(activeTransform).not.toBe(beforeTransform)
  })
})
