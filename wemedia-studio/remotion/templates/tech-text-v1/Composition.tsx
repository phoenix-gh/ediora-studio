import { AbsoluteFill, Html5Audio, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'

import {
  CONTINUITY_EPSILON_SECONDS,
  type TextVideoRenderInput,
  type TextVideoSegment,
} from '../../types'
import { TimedText } from '../../shared/TimedText'
import { sceneFrameRange } from '../../../lib/text-video/scene-range'
import type { TechTextV1Props } from './config'

const BACKGROUND_STYLES: Record<
  TechTextV1Props['background'],
  {
    backgroundColor: string
    backgroundImage: string
    backgroundSize?: string
  }
> = {
  'dark-grid': {
    backgroundColor: '#050B18',
    backgroundImage: [
      'radial-gradient(circle at 50% 38%, rgba(30, 132, 180, 0.22), transparent 38%)',
      'linear-gradient(rgba(74, 191, 220, 0.085) 1px, transparent 1px)',
      'linear-gradient(90deg, rgba(74, 191, 220, 0.085) 1px, transparent 1px)',
    ].join(','),
  },
  'deep-space': {
    backgroundColor: '#030611',
    backgroundImage: [
      'radial-gradient(circle at 18% 24%, rgba(54, 89, 164, 0.35), transparent 32%)',
      'radial-gradient(circle at 82% 68%, rgba(22, 183, 215, 0.18), transparent 35%)',
      'linear-gradient(160deg, #080D22 0%, #030611 72%)',
    ].join(','),
  },
  'clean-gradient': {
    backgroundColor: '#071329',
    backgroundImage: 'linear-gradient(145deg, #102A4D 0%, #071329 48%, #111D38 100%)',
  },
}

const TEXT_DENSITY_SCALE: Record<TechTextV1Props['textDensity'], number> = {
  compact: 0.88,
  standard: 1,
  spacious: 1.12,
}

export function sceneAnimationFrameRange(
  scene: Pick<TextVideoSegment, 'start' | 'end'>,
  fps: number,
) {
  return sceneFrameRange(scene, fps)
}

export function findActiveTextVideoSegment(
  segments: TextVideoSegment[],
  seconds: number,
) {
  const segment = segments.find(
    (item, index) => {
      const previous = segments[index - 1]
      const effectiveStart = index === 0
        && Math.abs(item.start) <= CONTINUITY_EPSILON_SECONDS
        ? 0
        : previous
          && Math.abs(item.start - previous.end)
            <= CONTINUITY_EPSILON_SECONDS
          ? previous.end
          : item.start
      return seconds >= effectiveStart && seconds < item.end
    },
  )
  if (!segment) {
    throw new Error(
      `文字视频渲染契约错误：${seconds} 秒没有对应的连续分镜`,
    )
  }
  return segment
}

export function TechTextV1Composition(
  props: TextVideoRenderInput<TechTextV1Props>,
) {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const seconds = frame / fps
  const segment = findActiveTextVideoSegment(props.segments, seconds)
  const portrait = height > width
  const landscape = width > height
  const {
    inFrame: segmentStartFrame,
    outFrame: segmentEndFrame,
  } = sceneAnimationFrameRange(segment, fps)
  const sceneProgress = interpolate(
    frame,
    [segmentStartFrame, Math.max(segmentStartFrame + 1, segmentEndFrame + 1)],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  )
  const templateProps = props.templateProps
  const densityScale = TEXT_DENSITY_SCALE[templateProps.textDensity]
  const baseFontSize = portrait
    ? width * 0.102
    : landscape
      ? height * 0.118
      : width * 0.09
  const fontSize = baseFontSize * densityScale
  const backgroundStyle = BACKGROUND_STYLES[templateProps.background]
  const backgroundSize = templateProps.background === 'dark-grid'
    ? `auto, ${Math.round(width / 12)}px ${Math.round(width / 12)}px, ${Math.round(width / 12)}px ${Math.round(width / 12)}px`
    : backgroundStyle.backgroundSize
  const brand = [
    templateProps.brandTitle,
    templateProps.brandSubtitle,
  ].filter(Boolean).join(' / ')

  return (
    <AbsoluteFill
      data-testid="template-background"
      style={{
        overflow: 'hidden',
        ...backgroundStyle,
        backgroundSize,
      }}
    >
      {props.audio ? <Html5Audio src={props.audio} /> : null}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(${112 + sceneProgress * 8}deg, rgba(6, 13, 31, 0.05), rgba(20, 226, 255, 0.07), rgba(4, 9, 22, 0.35))`,
        }}
      />
      {templateProps.showBrand ? (
        <div
          style={{
            position: 'absolute',
            left: portrait ? '8%' : '5%',
            right: portrait ? '8%' : '5%',
            top: portrait ? '10%' : '8%',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            color: '#7A95AD',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: Math.max(18, Math.round(fontSize * 0.24)),
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
        >
          <span
            data-testid="brand-accent"
            style={{
              width: 34,
              height: 3,
              background: templateProps.accentColor,
              boxShadow: `0 0 14px ${templateProps.accentColor}`,
            }}
          />
          {brand}
        </div>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: portrait ? '9%' : '9%',
          right: portrait ? '9%' : '9%',
          top: portrait ? '27%' : '23%',
          bottom: portrait ? '25%' : '20%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize,
        }}
      >
        <TimedText
          segment={segment}
          segmentStartFrame={segmentStartFrame}
          accent={templateProps.accentColor}
        />
      </div>
      {templateProps.showProgress ? (
        <div
          data-testid="scene-progress"
          style={{
            position: 'absolute',
            left: portrait ? '9%' : '5%',
            right: portrait ? '9%' : '5%',
            bottom: portrait ? '9%' : '7%',
            height: 2,
            background: 'rgba(111, 151, 173, 0.25)',
          }}
        >
          <div
            data-testid="scene-progress-fill"
            style={{
              width: `${sceneProgress * 100}%`,
              height: '100%',
              background: templateProps.accentColor,
              boxShadow: `0 0 14px ${templateProps.accentColor}`,
            }}
          />
        </div>
      ) : null}
      {templateProps.showSceneNumber ? (
        <div
          style={{
            position: 'absolute',
            right: portrait ? '9%' : '5%',
            bottom: portrait ? '11%' : '9%',
            color: '#6E8599',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: Math.max(16, Math.round(fontSize * 0.2)),
          }}
        >
          {String(props.segments.indexOf(segment) + 1).padStart(2, '0')} / {String(props.segments.length).padStart(2, '0')}
        </div>
      ) : null}
    </AbsoluteFill>
  )
}
