import type {
  KineticRenderChunk,
  KineticWordCue,
} from '../types'

const TEXT_ENTER_FRAMES = 8

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function positiveFrameCount(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

export function motionLayersAtFrame(
  chunks: readonly KineticRenderChunk[],
  frame: number,
  fps: number,
  overlapFrames = 6,
) {
  if (frame < 0) return []
  if (!Number.isFinite(frame)) {
    throw new Error('frame must be finite')
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('fps must be finite and positive')
  }
  const overlap = positiveFrameCount(overlapFrames, 6)

  return chunks.flatMap((chunk, index) => {
    const startFrame = Math.ceil(chunk.start * fps)
    const endFrame = Math.ceil(chunk.end * fps)
    const mountStart = index === 0 ? 0 : startFrame - overlap
    const mountEnd = index === chunks.length - 1
      ? endFrame
      : endFrame + overlap
    if (frame < mountStart || frame >= mountEnd) return []

    return [{
      chunk,
      index,
      mounted: true as const,
      backgroundEnter: clamp01((frame - mountStart + 1) / overlap),
      textEnter: clamp01(
        (frame - startFrame + (index === 0 ? 1 : 0))
        / TEXT_ENTER_FRAMES,
      ),
      hold: clamp01(
        (frame - startFrame - TEXT_ENTER_FRAMES)
        / Math.max(1, endFrame - startFrame - 14),
      ),
      exit: clamp01((frame - endFrame) / overlap),
    }]
  })
}

export function wordEmphasisProgress(
  cue: KineticWordCue | undefined,
  frame: number,
  fps: number,
  durationFrames = 12,
) {
  if (
    !cue
    || cue.emphasis !== 'highlight'
    || frame < 0
  ) {
    return 0
  }
  if (!Number.isFinite(frame)) {
    throw new Error('frame must be finite')
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('fps must be finite and positive')
  }

  const startFrame = Math.round(cue.start * fps)
  const duration = positiveFrameCount(durationFrames, 12)
  const phase = (frame - startFrame) / duration
  if (phase <= 0 || phase >= 1) return 0

  const triangle = phase <= 0.5
    ? phase * 2
    : (1 - phase) * 2
  return 1 - (1 - triangle) ** 3
}
