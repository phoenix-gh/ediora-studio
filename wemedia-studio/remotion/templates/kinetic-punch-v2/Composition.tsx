import type { CSSProperties, ReactNode } from 'react'
import {
  AbsoluteFill,
  Html5Audio,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'

import {
  motionLayersAtFrame,
  wordEmphasisProgress,
} from '../../shared/motion-lifecycle'
import type {
  KineticRenderChunk,
  TextVideoRenderInput,
} from '../../types'
import type { KineticPunchV2Props } from './config'
import { kineticLayout } from './layout'

type IntensityChunk = KineticRenderChunk & { intensity: number }

function fallbackChunks(
  props: TextVideoRenderInput<KineticPunchV2Props>,
): IntensityChunk[] {
  return props.segments.flatMap(segment => {
    const chunks = segment.chunks ?? [{
      id: `${segment.id}-fallback`,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      motionPreset: segment.animation === 'impact'
        || segment.animation === 'contrast'
        ? segment.animation
        : 'reveal',
      emphasis: 'normal',
      words: [{
        text: segment.text,
        start: segment.start,
        end: segment.end,
        emphasis: 'normal',
      }],
    }]
    return chunks.map(chunk => ({
      ...chunk,
      intensity: segment.intensity ?? 0.65,
    }))
  })
}

function normalizedSpans(
  chunk: KineticRenderChunk,
): Array<{ start: number; end: number }> {
  const offsets: Array<{ start: number; end: number }> = []
  const normalized: string[] = []
  let rawOffset = 0
  for (const character of Array.from(chunk.text)) {
    const start = rawOffset
    rawOffset += character.length
    if (/\s/u.test(character)) continue
    normalized.push(character)
    offsets.push({ start, end: rawOffset })
  }

  function sequenceIndex(needle: string[], from: number) {
    for (
      let index = from;
      index <= normalized.length - needle.length;
      index += 1
    ) {
      if (needle.every((character, offset) => (
        normalized[index + offset] === character
      ))) return index
    }
    return -1
  }

  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const cue of chunk.words) {
    const needle = Array.from(cue.text.replace(/\s/gu, ''))
    if (needle.length === 0) continue
    const match = sequenceIndex(needle, cursor)
    if (match < 0) continue
    cursor = match + needle.length
    if (cue.emphasis !== 'highlight') continue
    const finalOffset = offsets[cursor - 1]
    if (!offsets[match] || !finalOffset) continue
    spans.push({
      start: offsets[match].start,
      end: finalOffset.end,
    })
  }

  return spans.reduce<Array<{ start: number; end: number }>>(
    (merged, span) => {
      const previous = merged.at(-1)
      if (
        previous
        && /^\s*$/u.test(chunk.text.slice(previous.end, span.start))
      ) {
        previous.end = span.end
      } else {
        merged.push({ ...span })
      }
      return merged
    },
    [],
  )
}

function highlightedText(
  chunk: KineticRenderChunk,
  emphasis: number,
  accentColor: string,
): ReactNode {
  const highlighted = normalizedSpans(chunk)
  if (highlighted.length === 0) return chunk.text

  const fragments: ReactNode[] = []
  let cursor = 0
  highlighted.forEach((span, index) => {
    fragments.push(chunk.text.slice(cursor, span.start))
    fragments.push(
      <span
        data-testid={`kinetic-highlight-${chunk.id}`}
        key={`${chunk.id}-highlight-${index}`}
        style={{
          color: accentColor,
          display: 'inline-block',
          transform: `scale(${1 + emphasis * 0.12})`,
          transformOrigin: 'center bottom',
        }}
      >
        {chunk.text.slice(span.start, span.end)}
      </span>,
    )
    cursor = span.end
  })
  fragments.push(chunk.text.slice(cursor))
  return fragments
}

export function KineticPunchV2Composition(
  props: TextVideoRenderInput<KineticPunchV2Props>,
) {
  const frame = useCurrentFrame()
  const {
    width,
    height,
    fps,
    durationInFrames,
  } = useVideoConfig()
  const chunks = fallbackChunks(props)
  const layers = motionLayersAtFrame(chunks, frame, fps)
  const {
    accentColor,
    brandTitle,
    palette,
    showBrand,
    showProgress,
  } = props.templateProps
  const night = palette === 'night'
  const pageColor = night ? '#10110E' : '#F2F0E8'
  const foreground = night ? '#F7F5E9' : '#171714'
  const inverse = night ? '#171714' : '#F7F5E9'
  const progress = Math.max(
    0,
    Math.min(1, (frame + 1) / Math.max(1, durationInFrames)),
  )

  return (
    <AbsoluteFill
      data-testid="template-kinetic-punch-v2"
      style={{
        backgroundColor: pageColor,
        color: foreground,
        fontFamily: '"Inter", "Source Han Sans SC", sans-serif',
        overflow: 'hidden',
      }}
    >
      {props.audio ? <Html5Audio src={props.audio} /> : null}

      {layers.map((layer) => {
        const motionStrength = 0.25 + layer.chunk.intensity * 0.75
        const layout = kineticLayout(
          width,
          height,
          layer.chunk.text.replace(/\s/gu, '').length,
        )
        const cueEmphasis = Math.max(
          0,
          ...layer.chunk.words.map(cue => (
            wordEmphasisProgress(cue, frame, fps)
          )),
        )
        const contrastActive = (
          layer.chunk.motionPreset === 'contrast'
          && cueEmphasis > 0
        )
        const blockColor = contrastActive ? foreground : accentColor
        const textColor = contrastActive ? pageColor : foreground
        const blockTransform = layer.chunk.motionPreset === 'contrast'
          ? `translateX(${(
              (1 - layer.backgroundEnter) * 100 + layer.exit * 28
            ) * motionStrength}%)`
          : `translateX(${(
              (1 - layer.backgroundEnter) * -18 - layer.exit * 24
            ) * motionStrength}%) rotate(${layout.blockAngle}deg)`
        const baseScale = layer.chunk.motionPreset === 'impact'
          ? 1 - (1 - layer.textEnter) * 0.06 * motionStrength
          : 1 + layer.hold * 0.018 * motionStrength
        const textTransform = (
          `translate(${layer.exit * 42 * motionStrength}px, `
          + `${(
            (1 - layer.textEnter) * 42 - layer.exit * 18
          ) * motionStrength}px) `
          + `scale(${baseScale})`
        )
        const sharedTextStyle: CSSProperties = {
          display: '-webkit-box',
          fontSize: layout.fontSize,
          fontWeight: 900,
          letterSpacing: '-0.055em',
          lineHeight: layout.lineHeight,
          maxWidth: layout.maxTextWidth,
          overflow: 'hidden',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: layout.maxLines,
        }

        return (
          <div
            data-testid={`kinetic-layer-${layer.chunk.id}`}
            key={layer.chunk.id}
            style={{ position: 'absolute', inset: 0 }}
          >
            <div
              data-testid={`kinetic-block-${layer.chunk.id}`}
              style={{
                position: 'absolute',
                zIndex: 10 + layer.index,
                left: -width * 0.08,
                right: -width * 0.08,
                top: height * 0.29,
                minHeight: height * 0.38,
                backgroundColor: blockColor,
                opacity: 1 - layer.exit,
                transform: blockTransform,
                transformOrigin: 'center',
              }}
            />
            <div
              data-testid={`kinetic-text-${layer.chunk.id}`}
              style={{
                ...sharedTextStyle,
                position: 'absolute',
                zIndex: 100 + layer.index,
                left: layout.safeInsetX,
                right: layout.safeInsetX,
                top: height * 0.37,
                color: layer.chunk.motionPreset === 'contrast'
                  ? inverse
                  : textColor,
                clipPath: `inset(0 ${(1 - layer.textEnter) * 100}% 0 0)`,
                opacity: layer.textEnter === 0 ? 0 : 1 - layer.exit,
                transform: textTransform,
                transformOrigin: 'left center',
              }}
            >
              {highlightedText(
                layer.chunk,
                cueEmphasis * motionStrength,
                blockColor === accentColor ? pageColor : accentColor,
              )}
            </div>
          </div>
        )
      })}

      {showBrand ? (
        <div
          style={{
            position: 'absolute',
            zIndex: 300,
            left: Math.max(32, width * 0.07),
            top: Math.max(28, height * 0.04),
            color: foreground,
            fontSize: Math.max(18, Math.round(Math.min(width, height) * 0.025)),
            fontWeight: 800,
            letterSpacing: '0.14em',
          }}
        >
          {brandTitle}
        </div>
      ) : null}

      {showProgress ? (
        <div
          style={{
            position: 'absolute',
            zIndex: 300,
            left: Math.max(32, width * 0.07),
            right: Math.max(32, width * 0.07),
            bottom: Math.max(28, height * 0.04),
            height: Math.max(5, Math.round(height * 0.004)),
            backgroundColor: night ? '#2D2E28' : '#D6D2C6',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress * 100}%`,
              height: '100%',
              backgroundColor: accentColor,
            }}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  )
}
