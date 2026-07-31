import { z } from 'zod'

import { resolveTextVideoTemplate } from './registry'
import {
  CONTINUITY_EPSILON_SECONDS,
  type TextVideoAspectRatio,
  type TextVideoRenderInput,
  type TextVideoTemplateManifest,
} from './types'

export type { TextVideoRenderInput, TextVideoSegment } from './types'
export { CONTINUITY_EPSILON_SECONDS } from './types'

const CONTINUITY_ERROR = 'segments must continuously cover the master audio'

const compositionSchema = z.object({
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fps: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

const kineticWordCueSchema = z.object({
  text: z.string().refine(value => value.trim().length > 0, {
    message: 'word cue text must not be blank',
  }),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  emphasis: z.enum(['normal', 'highlight']),
}).strict().refine(cue => cue.end > cue.start, {
  message: 'word cue end must follow start',
  path: ['end'],
})

const kineticRenderChunkSchema = z.object({
  id: z.string().refine(value => value.trim().length > 0, {
    message: 'chunk id must not be blank',
  }),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  text: z.string().refine(value => value.trim().length > 0, {
    message: 'chunk text must not be blank',
  }),
  motionPreset: z.enum(['impact', 'reveal', 'contrast']),
  emphasis: z.enum(['normal', 'punch']),
  words: z.array(kineticWordCueSchema).min(1),
}).strict().refine(chunk => chunk.end > chunk.start, {
  message: 'chunk end must follow start',
  path: ['end'],
})

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
  transition: z.literal('block-wipe').optional(),
  intensity: z.number().finite().min(0).max(1).optional(),
  chunks: z.array(kineticRenderChunkSchema).min(1).optional(),
}).strict().refine(segment => segment.end > segment.start, {
  message: 'segment end must follow start',
  path: ['end'],
}).refine(segment => {
  const present = [
    segment.transition !== undefined,
    segment.intensity !== undefined,
    segment.chunks !== undefined,
  ]
  return present.every(value => value === present[0])
}, {
  message: 'segment motion fields must be provided together',
  path: ['chunks'],
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
  const width = BigInt(composition.width)
  const height = BigInt(composition.height)
  if (width === height) return '1:1'
  if (width * BigInt(16) === height * BigInt(9)) return '9:16'
  if (width * BigInt(9) === height * BigInt(16)) return '16:9'
  return null
}

function fail(message: string): never {
  throw new Error(message)
}

function validateMasterDuration(masterDuration: number) {
  if (!Number.isFinite(masterDuration) || masterDuration <= 0) {
    fail('master duration must be finite and positive')
  }
}

export function parseTextVideoRenderInputWithManifest<
  P extends Record<string, unknown>,
>(
  value: unknown,
  {
    masterDuration,
    manifest,
  }: {
    masterDuration: number
    manifest: TextVideoTemplateManifest<P>
  },
): TextVideoRenderInput<P> {
  validateMasterDuration(masterDuration)

  const envelope = textVideoRenderInputSchema.parse(value)
  if (
    envelope.templateId !== manifest.id
    || envelope.templateVersion !== manifest.version
  ) {
    fail(
      `unknown text-video template: ${envelope.templateId}@${envelope.templateVersion}`,
    )
  }
  const templateProps = manifest.propsSchema.parse(envelope.templateProps)
  const ratio = aspectRatio(envelope.composition)

  if (!ratio || !manifest.aspectRatios.includes(ratio)) {
    fail('composition must use a supported aspect ratio')
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
    if (segment.chunks) {
      if (manifest.id !== 'kinetic-punch-v2' || manifest.version !== 1) {
        fail('segment motion is only supported by kinetic-punch-v2@1')
      }
      if (
        !segment.transition
        || !(manifest.transitions as readonly string[])
          .includes(segment.transition)
      ) {
        fail(`segment transition is not supported: ${segment.transition}`)
      }

      const chunkIds = new Set<string>()
      let chunkCursor = segment.start
      for (const chunk of segment.chunks) {
        if (chunkIds.has(chunk.id)) fail('chunk ids must be unique')
        chunkIds.add(chunk.id)
        if (
          !(manifest.animations as readonly string[])
            .includes(chunk.motionPreset)
        ) {
          fail(`chunk motion preset is not supported: ${chunk.motionPreset}`)
        }
        if (
          Math.abs(chunk.start - chunkCursor)
          > CONTINUITY_EPSILON_SECONDS
        ) {
          fail('chunks must continuously cover the segment')
        }

        let cueCursor = chunk.start
        for (const cue of chunk.words) {
          if (
            cue.start < chunk.start - CONTINUITY_EPSILON_SECONDS
            || cue.end > chunk.end + CONTINUITY_EPSILON_SECONDS
            || cue.start < cueCursor - CONTINUITY_EPSILON_SECONDS
          ) {
            fail('word cues must be ordered inside their chunk')
          }
          cueCursor = cue.end
        }
        chunkCursor = chunk.end
      }
      if (
        Math.abs(chunkCursor - segment.end)
        > CONTINUITY_EPSILON_SECONDS
      ) {
        fail('chunks must continuously cover the segment')
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

  const segments = envelope.segments.map(segment => ({
    ...segment,
    highlight: [...segment.highlight],
    chunks: segment.chunks?.map(chunk => ({
      ...chunk,
      words: chunk.words.map(cue => ({ ...cue })),
    })),
  }))
  segments[0].start = 0
  for (let index = 1; index < segments.length; index += 1) {
    segments[index].start = segments[index - 1].end
  }
  segments[segments.length - 1].end = masterDuration
  for (const segment of segments) {
    if (segment.end <= segment.start) {
      fail(CONTINUITY_ERROR)
    }
  }

  return {
    ...envelope,
    segments,
    templateProps,
  }
}

export function parseTextVideoRenderInput(
  value: unknown,
  { masterDuration }: { masterDuration: number },
): TextVideoRenderInput {
  validateMasterDuration(masterDuration)
  const envelope = textVideoRenderInputSchema.parse(value)
  const manifest = resolveTextVideoTemplate(
    envelope.templateId,
    envelope.templateVersion,
  ) as unknown as TextVideoTemplateManifest<Record<string, unknown>>
  return parseTextVideoRenderInputWithManifest(envelope, {
    masterDuration,
    manifest,
  })
}
