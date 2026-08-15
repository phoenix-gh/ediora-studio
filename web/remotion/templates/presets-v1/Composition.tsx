import type { CSSProperties, ReactNode } from 'react'
import {
  AbsoluteFill,
  Html5Audio,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'

import { sceneFrameRange } from '../../../lib/text-video/scene-range'
import { TimedText } from '../../shared/TimedText'
import {
  CONTINUITY_EPSILON_SECONDS,
  type TextVideoRenderInput,
  type TextVideoSegment,
} from '../../types'
import type { PresetTextProps } from './config'

const PALETTES = {
  night: {
    background: '#090A10',
    foreground: '#F8FAFC',
    muted: '#8A91A3',
    surface: '#151822',
  },
  light: {
    background: '#EFE9DC',
    foreground: '#171714',
    muted: '#726E64',
    surface: '#FFFDF7',
  },
  warm: {
    background: '#24131A',
    foreground: '#FFF8EE',
    muted: '#C8A6A0',
    surface: '#3A1D28',
  },
} as const

function activeSegment(
  segments: TextVideoSegment[],
  seconds: number,
) {
  const segment = segments.find((item, index) => {
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
  })
  if (!segment) {
    throw new Error(`文字视频渲染契约错误：${seconds} 秒没有对应的连续分镜`)
  }
  return segment
}

function emphasize(
  text: string,
  highlights: string[],
  accent: string,
) {
  const matches = highlights.filter(Boolean).sort(
    (left, right) => right.length - left.length,
  )
  if (matches.length === 0) return text
  const pattern = new RegExp(
    `(${matches.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g',
  )
  return text.split(pattern).map((part, index) => (
    matches.includes(part)
      ? <span key={`${part}-${index}`} style={{ color: accent }}>{part}</span>
      : part
  ))
}

function Brand({
  title,
  accent,
  foreground,
}: {
  title: string
  accent: string
  foreground: string
}) {
  return (
    <div style={{
      position: 'absolute',
      top: '7%',
      left: '7%',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      color: foreground,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontWeight: 700,
      fontSize: 22,
      letterSpacing: '0.14em',
    }}>
      <span style={{ width: 24, height: 6, borderRadius: 99, background: accent }} />
      {title}
    </div>
  )
}

function Progress({
  value,
  accent,
}: {
  value: number
  accent: string
}) {
  return (
    <div style={{
      position: 'absolute',
      left: '7%',
      right: '7%',
      bottom: '6%',
      height: 5,
      borderRadius: 99,
      overflow: 'hidden',
      background: 'rgba(127,127,127,.25)',
    }}>
      <div style={{
        height: '100%',
        width: `${value * 100}%`,
        borderRadius: 99,
        background: accent,
      }} />
    </div>
  )
}

function KineticPunch({
  segment,
  startFrame,
  localProgress,
  accent,
  foreground,
  surface,
  index,
}: SceneViewProps) {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const entrance = spring({
    frame: Math.max(0, frame - startFrame),
    fps,
    config: { damping: 14, stiffness: 190, mass: 0.65 },
  })
  const portrait = height > width
  return (
    <>
      <div style={{
        position: 'absolute',
        width: portrait ? '120%' : '70%',
        height: '34%',
        left: '-8%',
        top: `${26 + localProgress * 6}%`,
        background: accent,
        transform: `rotate(-7deg) scaleX(${0.82 + entrance * 0.18})`,
        opacity: 0.94,
      }} />
      <div style={{
        position: 'absolute',
        right: '3%',
        bottom: '10%',
        color: surface,
        fontSize: portrait ? width * 0.52 : height * 0.52,
        fontWeight: 950,
        lineHeight: 0.8,
        opacity: 0.8,
      }}>
        {String(index + 1).padStart(2, '0')}
      </div>
      <div style={{
        position: 'absolute',
        inset: '23% 8% 20%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: portrait ? width * 0.12 : height * 0.15,
        filter: 'drop-shadow(0 12px 24px rgba(0,0,0,.35))',
        color: foreground,
      }}>
        <TimedText
          segment={segment}
          segmentStartFrame={startFrame}
          accent={accent}
          color={foreground}
        />
      </div>
    </>
  )
}

function CaptionFocus({
  segment,
  startFrame,
  accent,
  foreground,
  surface,
  index,
}: SceneViewProps) {
  const { width, height } = useVideoConfig()
  const portrait = height > width
  return (
    <>
      <div style={{
        position: 'absolute',
        inset: '16% 7% 20%',
        border: `2px solid ${accent}40`,
        borderRadius: portrait ? 52 : 36,
        background: surface,
        boxShadow: `0 28px 90px ${accent}18`,
      }} />
      <div style={{
        position: 'absolute',
        top: '19%',
        left: '11%',
        padding: '10px 18px',
        borderRadius: 999,
        color: '#FFFFFF',
        background: accent,
        fontSize: Math.max(18, width * 0.022),
        fontWeight: 800,
      }}>
        CAPTION {String(index + 1).padStart(2, '0')}
      </div>
      <div style={{
        position: 'absolute',
        inset: '27% 11% 26%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: foreground,
        fontSize: portrait ? width * 0.105 : height * 0.13,
      }}>
        <TimedText
          segment={segment}
          segmentStartFrame={startFrame}
          accent={accent}
          color={foreground}
        />
      </div>
    </>
  )
}

function EditorialCard({
  segment,
  startFrame,
  accent,
  foreground,
  surface,
  index,
}: SceneViewProps) {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const portrait = height > width
  const reveal = spring({
    frame: Math.max(0, frame - startFrame),
    fps,
    config: { damping: 18, stiffness: 120 },
  })
  return (
    <>
      <div
        data-testid="editorial-card-surface"
        style={{
        position: 'absolute',
        inset: portrait ? '16% 7% 13%' : '14% 9% 12%',
        borderRadius: portrait ? 24 : 18,
        background: surface,
        boxShadow: '0 34px 100px rgba(48,35,20,.16)',
        transform: segment.animation === 'scale'
          ? `scale(${0.88 + reveal * 0.12})`
          : `translateY(${(1 - reveal) * 50}px) rotate(${(1 - reveal) * 1.5}deg)`,
        opacity: reveal,
      }} />
      <div style={{
        position: 'absolute',
        top: portrait ? '21%' : '20%',
        left: portrait ? '13%' : '15%',
        color: accent,
        fontFamily: 'Georgia, "Noto Serif CJK SC", serif',
        fontSize: portrait ? width * 0.18 : height * 0.18,
        lineHeight: 0.8,
      }}>
        “
      </div>
      <div style={{
        position: 'absolute',
        inset: portrait ? '31% 13% 26%' : '29% 15% 25%',
        display: 'flex',
        alignItems: 'center',
        color: foreground,
        fontFamily: 'Georgia, "Noto Serif CJK SC", serif',
        fontSize: portrait ? width * 0.09 : height * 0.11,
        fontWeight: 700,
        lineHeight: 1.32,
        whiteSpace: 'pre-line',
        opacity: reveal,
      }}>
        {emphasize(segment.text, segment.highlight, accent)}
      </div>
      <div style={{
        position: 'absolute',
        right: portrait ? '13%' : '15%',
        bottom: '18%',
        color: accent,
        fontFamily: 'Georgia, serif',
        fontSize: Math.max(22, width * 0.026),
      }}>
        — {String(index + 1).padStart(2, '0')}
      </div>
    </>
  )
}

function VoicePulse({
  segment,
  startFrame,
  localProgress,
  accent,
  foreground,
}: SceneViewProps) {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const portrait = height > width
  const bars = Array.from({ length: 21 }, (_, index) => {
    const phase = frame * 0.16 + index * 0.72
    const heightValue = 26 + Math.abs(Math.sin(phase)) * 104
    return (
      <span key={index} style={{
        width: portrait ? 13 : 10,
        height: heightValue,
        borderRadius: 99,
        background: accent,
        opacity: 0.35 + Math.abs(Math.sin(phase * 0.7)) * 0.65,
      }} />
    )
  })
  return (
    <>
      <div style={{
        position: 'absolute',
        width: portrait ? width * 0.82 : height * 0.82,
        height: portrait ? width * 0.82 : height * 0.82,
        left: '50%',
        top: '42%',
        borderRadius: '50%',
        border: `2px solid ${accent}66`,
        boxShadow: `0 0 ${80 + localProgress * 80}px ${accent}33`,
        transform: `translate(-50%, -50%) scale(${0.86 + localProgress * 0.08})`,
      }} />
      <div style={{
        position: 'absolute',
        left: '10%',
        right: '10%',
        top: portrait ? '22%' : '19%',
        bottom: portrait ? '38%' : '35%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: foreground,
        fontSize: portrait ? width * 0.1 : height * 0.125,
      }}>
        <TimedText
          segment={segment}
          segmentStartFrame={startFrame}
          accent={accent}
          color={foreground}
        />
      </div>
      <div style={{
        position: 'absolute',
        left: '12%',
        right: '12%',
        bottom: portrait ? '17%' : '14%',
        height: 140,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: portrait ? 11 : 8,
      }}>
        {bars}
      </div>
    </>
  )
}

type SceneViewProps = {
  segment: TextVideoSegment
  startFrame: number
  localProgress: number
  accent: string
  foreground: string
  surface: string
  index: number
}

const SCENE_VIEWS: Record<
  PresetTextProps['style'],
  (props: SceneViewProps) => ReactNode
> = {
  'kinetic-punch': KineticPunch,
  'caption-focus': CaptionFocus,
  'editorial-card': EditorialCard,
  'voice-pulse': VoicePulse,
}

export function PresetTextComposition(
  props: TextVideoRenderInput<PresetTextProps>,
) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const seconds = frame / fps
  const segment = activeSegment(props.segments, seconds)
  const index = props.segments.indexOf(segment)
  const { inFrame, outFrame } = sceneFrameRange(segment, fps)
  const localProgress = interpolate(
    frame,
    [inFrame, Math.max(inFrame + 1, outFrame + 1)],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  )
  const template = props.templateProps
  const palette = PALETTES[template.palette]
  const SceneView = SCENE_VIEWS[template.style]
  const background: CSSProperties = template.style === 'voice-pulse'
    ? {
      backgroundColor: palette.background,
      backgroundImage: `radial-gradient(circle at 50% 35%, ${template.accentColor}38, transparent 44%), linear-gradient(150deg, ${palette.background}, ${palette.surface})`,
    }
    : {
      backgroundColor: palette.background,
      backgroundImage: template.style === 'caption-focus'
        ? `radial-gradient(circle at 50% 22%, ${template.accentColor}22, transparent 45%)`
        : undefined,
    }

  return (
    <AbsoluteFill
      data-testid={`template-${template.style}`}
      style={{ overflow: 'hidden', ...background }}
    >
      {props.audio ? <Html5Audio src={props.audio} /> : null}
      {template.showBrand && template.brandTitle ? (
        <Brand
          title={template.brandTitle}
          accent={template.accentColor}
          foreground={palette.foreground}
        />
      ) : null}
      <SceneView
        segment={segment}
        startFrame={inFrame}
        localProgress={localProgress}
        accent={template.accentColor}
        foreground={palette.foreground}
        surface={palette.surface}
        index={index}
      />
      {template.showProgress ? (
        <Progress value={(index + localProgress) / props.segments.length} accent={template.accentColor} />
      ) : null}
    </AbsoluteFill>
  )
}
