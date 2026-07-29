import { AbsoluteFill, Html5Audio, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'

import type { TextVideoRenderInput } from '../../types'
import type { TextVideoSegment } from '../../types'
import { TimedText } from '../../shared/TimedText'

export function findActiveTextVideoSegment(
  segments: TextVideoSegment[],
  seconds: number,
) {
  const segment = segments.find(
    item => seconds >= item.start && seconds < item.end,
  )
  if (!segment) {
    throw new Error(
      `文字视频渲染契约错误：${seconds} 秒没有对应的连续分镜`,
    )
  }
  return segment
}

export function TechTextV1Composition(props: TextVideoRenderInput) {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const seconds = frame / fps
  const segment = findActiveTextVideoSegment(props.segments, seconds)
  const portrait = height > width
  const landscape = width > height
  const segmentStartFrame = Math.round(segment.start * fps)
  const sceneProgress = interpolate(
    frame,
    [segmentStartFrame, Math.max(segmentStartFrame + 1, Math.round(segment.end * fps))],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  )
  const fontSize = portrait ? width * 0.102 : landscape ? height * 0.118 : width * 0.09

  return (
    <AbsoluteFill
      style={{
        overflow: 'hidden',
        backgroundColor: '#050B18',
        backgroundImage: [
          'radial-gradient(circle at 50% 38%, rgba(30, 132, 180, 0.22), transparent 38%)',
          'linear-gradient(rgba(74, 191, 220, 0.085) 1px, transparent 1px)',
          'linear-gradient(90deg, rgba(74, 191, 220, 0.085) 1px, transparent 1px)',
        ].join(','),
        backgroundSize: `auto, ${Math.round(width / 12)}px ${Math.round(width / 12)}px, ${Math.round(width / 12)}px ${Math.round(width / 12)}px`,
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
        <span style={{ width: 34, height: 3, background: '#69F6FF', boxShadow: '0 0 14px #69F6FF' }} />
        WEMEDIA / TEXT SIGNAL
      </div>
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
        <TimedText segment={segment} segmentStartFrame={segmentStartFrame} />
      </div>
      <div
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
          style={{
            width: `${sceneProgress * 100}%`,
            height: '100%',
            background: '#69F6FF',
            boxShadow: '0 0 14px #69F6FF',
          }}
        />
      </div>
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
    </AbsoluteFill>
  )
}
