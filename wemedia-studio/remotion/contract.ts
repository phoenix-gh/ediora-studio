import { z } from 'zod'

import { resolveTextVideoTemplate } from './registry'

export type {
  TextVideoRenderInput,
  TextVideoSegment,
} from './types'
import type { TextVideoAspectRatio, TextVideoRenderInput } from './types'

export const CONTINUITY_EPSILON_SECONDS = 0.001
const CONTINUITY_ERROR = 'segments must continuously cover the master audio'

const compositionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
}).strict()

const textVideoSegmentSchema = z.object({
  id: z.string().refine(value => value.trim().length > 0, {
    message: 'segment id must not be blank',
  }),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string().refine(value => value.trim().length > 0, {
    message: 'segment text must not be blank',
  }),
  highlight: z.array(z.string()),
  animation: z.string().min(1),
}).strict().refine(segment => segment.end > segment.start, {
  message: 'segment end must follow start',
  path: ['end'],
})

export const textVideoRenderInputSchema = z.object({
  templateId: z.string().min(1),
  templateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  composition: compositionSchema,
  audio: z.string(),
  segments: z.array(textVideoSegmentSchema).min(1),
  templateProps: z.unknown(),
}).strict()

function aspectRatio(
  composition: TextVideoRenderInput['composition'],
): TextVideoAspectRatio | null {
  if (composition.width === composition.height) return '1:1'
  if (composition.width * 16 === composition.height * 9) return '9:16'
  if (composition.width * 9 === composition.height * 16) return '16:9'
  return null
}

function fail(message: string): never {
  throw new Error(message)
}

export function parseTextVideoRenderInput(
  value: unknown,
  { masterDuration }: { masterDuration: number },
): TextVideoRenderInput {
  if (!Number.isFinite(masterDuration) || masterDuration <= 0) {
    fail('master duration must be finite and positive')
  }

  const envelope = textVideoRenderInputSchema.parse(value)
  const manifest = resolveTextVideoTemplate(
    envelope.templateId,
    envelope.templateVersion,
  )
  const templateProps = manifest.propsSchema.parse(envelope.templateProps)
  const ratio = aspectRatio(envelope.composition)

  if (!ratio || !manifest.aspectRatios.includes(ratio)) {
    fail('composition must use a supported aspect ratio')
  }

  const transition = (
    typeof templateProps === 'object'
    && templateProps !== null
    && 'transition' in templateProps
  ) ? templateProps.transition : undefined
  if (
    typeof transition !== 'string'
    || !manifest.transitions.includes(transition)
  ) {
    fail('template transition is not supported')
  }

  const ids = new Set<string>()
  for (const segment of envelope.segments) {
    if (ids.has(segment.id)) fail('segment ids must be unique')
    ids.add(segment.id)
    if (!(manifest.animations as readonly string[]).includes(segment.animation)) {
      fail(`segment animation is not supported: ${segment.animation}`)
    }
    for (const highlight of segment.highlight) {
      if (highlight && !segment.text.includes(highlight)) {
        fail('highlight must occur in segment text')
      }
    }
  }

  const first = envelope.segments[0]
  const last = envelope.segments[envelope.segments.length - 1]
  if (Math.abs(first.start) > CONTINUITY_EPSILON_SECONDS) {
    fail(CONTINUITY_ERROR)
  }
  for (let index = 1; index < envelope.segments.length; index += 1) {
    if (
      Math.abs(
        envelope.segments[index].start
        - envelope.segments[index - 1].end,
      ) > CONTINUITY_EPSILON_SECONDS
    ) {
      fail(CONTINUITY_ERROR)
    }
  }
  if (Math.abs(last.end - masterDuration) > CONTINUITY_EPSILON_SECONDS) {
    fail(CONTINUITY_ERROR)
  }

  return {
    ...envelope,
    templateProps,
  }
}
