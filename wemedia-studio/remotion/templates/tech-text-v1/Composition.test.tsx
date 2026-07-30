// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TECH_TEXT_V1_DEFAULTS,
  type TechTextV1Props,
} from './config'
import { TechTextV1Composition } from './Composition'
import type { TextVideoRenderInput } from '../../types'

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
      id: 'tech-text-v1',
      defaultProps: {},
      props: {},
    }),
  }
})

const DEFAULT_INPUT: TextVideoRenderInput<TechTextV1Props> = {
  templateId: 'tech-text-v1',
  templateVersion: 1,
  composition: {
    width: 1080,
    height: 1920,
    fps: 30,
  },
  audio: '',
  segments: [{
    id: 'scene-1',
    start: 0,
    end: 2,
    text: '测试正文',
    highlight: ['测试'],
    animation: 'fade-up',
  }],
  templateProps: TECH_TEXT_V1_DEFAULTS,
}

function renderComposition(templateProps: Partial<TechTextV1Props> = {}) {
  return render(
    <TechTextV1Composition
      {...DEFAULT_INPUT}
      templateProps={{
        ...TECH_TEXT_V1_DEFAULTS,
        ...templateProps,
      }}
    />,
  )
}

describe('TechTextV1Composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the configured default brand', () => {
    const view = renderComposition()

    expect(view.getByText('EDIORA / 述策')).toBeInTheDocument()
    expect(view.queryByText(/WEMEDIA/u)).not.toBeInTheDocument()
  })

  it('hides the brand when showBrand is false', () => {
    const view = renderComposition({ showBrand: false })

    expect(view.queryByText('EDIORA / 述策')).not.toBeInTheDocument()
  })

  it('gates scene numbers and progress independently', () => {
    const hidden = renderComposition({
      showProgress: false,
      showSceneNumber: false,
    })

    expect(hidden.queryByTestId('scene-progress')).not.toBeInTheDocument()
    expect(hidden.queryByText('01 / 01')).not.toBeInTheDocument()

    hidden.unmount()
    const shown = renderComposition()
    expect(shown.getByTestId('scene-progress')).toBeInTheDocument()
    expect(shown.getByText('01 / 01')).toBeInTheDocument()
  })

  it('uses the validated accent color for brand, progress, and text highlight', () => {
    const view = renderComposition({
      accentColor: '#A1B2C3',
    })

    const brandAccent = view.getByTestId('brand-accent')
    const progressFill = view.getByTestId('scene-progress-fill')
    expect(brandAccent).toHaveStyle({
      background: '#A1B2C3',
    })
    expect(brandAccent.style.boxShadow).toBe('0 0 14px #A1B2C3')
    expect(progressFill).toHaveStyle({
      background: '#A1B2C3',
    })
    expect(progressFill.style.boxShadow).toBe('0 0 14px #A1B2C3')
    expect(view.getByText('测试')).toHaveStyle({
      color: '#A1B2C3',
    })
  })

  it.each([
    ['dark-grid', 'linear-gradient(rgba(74, 191, 220, 0.085) 1px'],
    ['deep-space', 'radial-gradient(circle at 18% 24%'],
    ['clean-gradient', 'linear-gradient(145deg'],
  ] as const)('renders the %s background branch', (background, marker) => {
    const view = renderComposition({ background })

    expect(view.getByTestId('template-background')).toHaveStyle({
      backgroundImage: expect.stringContaining(marker),
    })
  })

  it.each([
    ['compact', 96.9408],
    ['standard', 110.16],
    ['spacious', 123.3792],
  ] as const)('applies the fixed %s text density multiplier', (
    textDensity,
    expectedFontSize,
  ) => {
    const view = renderComposition({ textDensity })
    const content = view.getByText('测试').parentElement?.parentElement

    expect(Number.parseFloat(content?.style.fontSize ?? 'NaN'))
      .toBeCloseTo(expectedFontSize, 4)
  })
})
