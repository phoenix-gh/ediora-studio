import type { CSSProperties, ReactNode } from 'react'
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'

import type { TextVideoSegment } from '../contract'

function highlightedText(text: string, highlights: string[], accent: string): ReactNode[] {
  const matches = highlights
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  if (matches.length === 0) return [text]

  const pattern = new RegExp(`(${matches.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  return text.split(pattern).map((part, index) => (
    matches.includes(part)
      ? <span key={`${part}-${index}`} style={{ color: accent, textShadow: `0 0 28px ${accent}80` }}>{part}</span>
      : part
  ))
}

export function TimedText({
  segment,
  segmentStartFrame,
  accent = '#69F6FF',
}: {
  segment: TextVideoSegment
  segmentStartFrame: number
  accent?: string
}) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const localFrame = Math.max(0, frame - segmentStartFrame)
  const entrance = spring({
    frame: localFrame,
    fps,
    config: { damping: 18, mass: 0.7, stiffness: 130 },
    durationInFrames: Math.round(fps * 0.65),
  })
  const reveal = interpolate(localFrame, [0, fps * 0.2], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  const motion: CSSProperties = segment.animation === 'scale'
    ? { opacity: reveal, transform: `scale(${0.82 + entrance * 0.18})` }
    : { opacity: reveal, transform: `translateY(${(1 - entrance) * 72}px)` }

  return (
    <div
      style={{
        ...motion,
        fontFamily: '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
        fontWeight: 800,
        letterSpacing: '-0.045em',
        lineHeight: 1.12,
        textAlign: 'center',
        whiteSpace: 'pre-line',
        color: '#F4F8FF',
      }}
    >
      {highlightedText(segment.text, segment.highlight, accent)}
    </div>
  )
}
