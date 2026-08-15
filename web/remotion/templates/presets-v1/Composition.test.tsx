// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TextVideoRenderInput } from '../../types'
import { PresetTextComposition } from './Composition'
import {
  CAPTION_FOCUS_DEFAULTS,
  EDITORIAL_CARD_DEFAULTS,
  KINETIC_PUNCH_DEFAULTS,
  VOICE_PULSE_DEFAULTS,
  type PresetTextProps,
} from './config'

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>()
  return {
    ...actual,
    useCurrentFrame: () => 15,
    useVideoConfig: () => ({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 60,
      id: 'preset',
      defaultProps: {},
      props: {},
    }),
  }
})

const INPUT: Omit<TextVideoRenderInput<PresetTextProps>, 'templateProps'> = {
  templateId: 'preset',
  templateVersion: 1,
  composition: { width: 1080, height: 1920, fps: 30 },
  audio: '',
  segments: [{
    id: 'scene-1',
    start: 0,
    end: 2,
    text: '把复杂观点讲清楚',
    highlight: ['讲清楚'],
    animation: 'fade-up',
  }],
}

describe('preset text compositions', () => {
  it.each([
    ['kinetic-punch', KINETIC_PUNCH_DEFAULTS],
    ['caption-focus', CAPTION_FOCUS_DEFAULTS],
    ['editorial-card', EDITORIAL_CARD_DEFAULTS],
    ['voice-pulse', VOICE_PULSE_DEFAULTS],
  ] as const)('renders the %s visual system from the common contract', (
    style,
    templateProps,
  ) => {
    const view = render(
      <PresetTextComposition
        {...INPUT}
        templateProps={templateProps}
      />,
    )

    expect(view.getByTestId(`template-${style}`)).toBeInTheDocument()
    expect(view.getByText(templateProps.brandTitle)).toBeInTheDocument()
    expect(view.getByText('讲清楚')).toHaveStyle({
      color: templateProps.accentColor,
    })
  })

  it('can hide shared brand and progress chrome', () => {
    const view = render(
      <PresetTextComposition
        {...INPUT}
        templateProps={{
          ...KINETIC_PUNCH_DEFAULTS,
          showBrand: false,
          showProgress: false,
        }}
      />,
    )

    expect(view.queryByText('EDIORA')).not.toBeInTheDocument()
    expect(view.container.querySelector('[style*="width: 25%"]'))
      .not.toBeInTheDocument()
  })

  it('uses the dark foreground color when a text template selects light palette', () => {
    const view = render(
      <PresetTextComposition
        {...INPUT}
        templateProps={{
          ...CAPTION_FOCUS_DEFAULTS,
          palette: 'light',
        }}
      />,
    )

    expect(view.getByText('讲清楚').parentElement).toHaveStyle({
      color: '#171714',
    })
  })

  it('honors both editorial scene animation choices', () => {
    const fade = render(
      <PresetTextComposition
        {...INPUT}
        segments={[{ ...INPUT.segments[0], animation: 'fade-up' }]}
        templateProps={EDITORIAL_CARD_DEFAULTS}
      />,
    )
    expect(fade.getByTestId('editorial-card-surface').style.transform)
      .toContain('translateY(')

    fade.unmount()
    const scale = render(
      <PresetTextComposition
        {...INPUT}
        segments={[{ ...INPUT.segments[0], animation: 'scale' }]}
        templateProps={EDITORIAL_CARD_DEFAULTS}
      />,
    )
    expect(scale.getByTestId('editorial-card-surface').style.transform)
      .toContain('scale(')
  })
})
