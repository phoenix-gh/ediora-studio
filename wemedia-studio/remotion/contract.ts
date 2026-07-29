import { z } from 'zod'

export const techTextV1PropsSchema = z.object({
  theme: z.literal('tech-blue'),
  font: z.literal('source-han-sans'),
  background: z.literal('dark-grid'),
  transition: z.literal('soft-push'),
  textDensity: z.enum(['compact', 'standard', 'spacious']),
})

const textVideoSegmentSchema = z.object({
  id: z.string().min(1),
  start: z.number().min(0),
  end: z.number().positive(),
  text: z.string().min(1),
  highlight: z.array(z.string()).default([]),
  animation: z.enum(['fade-up', 'scale']),
}).refine(segment => segment.end > segment.start, {
  message: 'segment end must follow start',
  path: ['end'],
})

export const textVideoRenderInputSchema = z.object({
  templateId: z.literal('tech-text-v1'),
  templateVersion: z.literal(1),
  composition: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  }).refine(
    value => value.width === value.height
      || value.width * 16 === value.height * 9
      || value.width * 9 === value.height * 16,
    { message: 'composition must use a supported aspect ratio' },
  ),
  audio: z.string(),
  segments: z.array(textVideoSegmentSchema).min(1),
  templateProps: techTextV1PropsSchema,
}).superRefine((value, context) => {
  for (let index = 1; index < value.segments.length; index += 1) {
    if (value.segments[index].start < value.segments[index - 1].end) {
      context.addIssue({
        code: 'custom',
        path: ['segments', index, 'start'],
        message: 'segments must be ordered and non-overlapping',
      })
    }
  }
})

export function parseTextVideoRenderInput(value: unknown) {
  return textVideoRenderInputSchema.parse(value)
}

export type TechTextV1Props = z.infer<typeof techTextV1PropsSchema>
export type TextVideoRenderInput = z.infer<typeof textVideoRenderInputSchema>
export type TextVideoSegment = TextVideoRenderInput['segments'][number]
