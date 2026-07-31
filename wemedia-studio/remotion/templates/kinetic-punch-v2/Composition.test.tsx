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
  it('uses scene intensity to scale deterministic motion', () => {
    currentFrame = 30
    const quiet = render(
      <KineticPunchV2Composition
        {...INPUT}
        segments={INPUT.segments.map(segment => ({
          ...segment,
          intensity: 0,
        }))}
      />,
    )
    const quietTransform = quiet.getByTestId('kinetic-text-chunk-a')
      .style.transform
    quiet.unmount()

    const strong = render(
      <KineticPunchV2Composition
        {...INPUT}
        segments={INPUT.segments.map(segment => ({
          ...segment,
          intensity: 1,
        }))}
      />,
    )

    expect(strong.getByTestId('kinetic-text-chunk-a').style.transform)
      .not.toBe(quietTransform)
  })

  it('renders normalized highlighted cues across visual whitespace', () => {
    currentFrame = 1
    const view = render(
      <KineticPunchV2Composition
        {...INPUT}
        segments={[{
          ...INPUT.segments[0],
          text: 'A I',
          highlight: ['A I'],
          chunks: [{
            id: 'chunk-spaced',
            start: 0,
            end: 6,
            text: 'A I',
            motionPreset: 'impact',
            emphasis: 'punch',
            words: [{
              text: 'AI',
              start: 0,
              end: 1,
              emphasis: 'highlight',
            }],
          }],
        }]}
      />,
    )

    expect(view.getByTestId('kinetic-highlight-chunk-spaced'))
      .toHaveTextContent('A I')
  })

  it('supports deterministic still rendering without an audio source', () => {
    currentFrame = 0
    const view = render(
      <KineticPunchV2Composition {...INPUT} audio="" />,
    )

    expect(view.queryByTestId('kinetic-audio')).not.toBeInTheDocument()
    expect(view.getByTestId('template-kinetic-punch-v2'))
      .toBeInTheDocument()
  })

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
    expect(view.getByTestId('kinetic-highlight-chunk-b')).toHaveStyle({
      color: '#10110E',
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

  it.each([
    [89, '0', true],
    [90, '0', true],
    [91, null, true],
    [96, null, false],
  ])('keeps continuous layers around frame %i', (
    frame,
    expectedOpacity,
    outgoingMounted,
  ) => {
    currentFrame = frame
    const view = render(<KineticPunchV2Composition {...INPUT} />)

    expect(Boolean(view.queryByTestId('kinetic-text-chunk-a')))
      .toBe(outgoingMounted)
    expect(view.getByTestId('kinetic-block-chunk-b')).toBeInTheDocument()
    const incoming = view.getByTestId('kinetic-text-chunk-b')
    if (expectedOpacity === null) {
      expect(incoming.style.opacity).not.toBe('0')
    } else {
      expect(incoming.style.opacity).toBe(expectedOpacity)
    }
  })

  it('keeps subtle hold movement alive across a long chunk', () => {
    currentFrame = 30
    const early = render(<KineticPunchV2Composition {...INPUT} />)
    const earlyTransform = early.getByTestId('kinetic-text-chunk-a')
      .style.transform
    early.unmount()

    currentFrame = 60
    const later = render(<KineticPunchV2Composition {...INPUT} />)
    const laterTransform = later.getByTestId('kinetic-text-chunk-a')
      .style.transform

    expect(laterTransform).not.toBe(earlyTransform)
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

  it('starts highlight emphasis within one frame of the word cue', () => {
    currentFrame = 96
    const atCue = render(<KineticPunchV2Composition {...INPUT} />)
    expect(atCue.getByTestId('kinetic-highlight-chunk-b').style.transform)
      .toBe('scale(1)')
    atCue.unmount()

    currentFrame = 97
    const nextFrame = render(<KineticPunchV2Composition {...INPUT} />)
    expect(nextFrame.getByTestId('kinetic-highlight-chunk-b').style.transform)
      .not.toBe('scale(1)')
  })
})
