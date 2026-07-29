import { z } from 'zod'

import type { TextVideoTemplateManifest } from '../../types'
import { TechTextV1Composition } from './Composition'

export const TECH_TEXT_V1_ID = 'tech-text-v1'
export const TECH_TEXT_V1_VERSION = 1

export const techTextV1PropsSchema = z.object({
  theme: z.literal('tech-blue'),
  font: z.literal('source-han-sans'),
  background: z.literal('dark-grid'),
  transition: z.literal('soft-push'),
  textDensity: z.enum(['compact', 'standard', 'spacious']),
}).strict()

export type TechTextV1Props = z.infer<typeof techTextV1PropsSchema>

export const techTextV1Manifest = {
  id: TECH_TEXT_V1_ID,
  version: TECH_TEXT_V1_VERSION,
  compositionId: TECH_TEXT_V1_ID,
  name: '科技资讯动态文字',
  description: '深色科技网格、关键词高亮与节奏化文字转场',
  component: TechTextV1Composition,
  propsSchema: techTextV1PropsSchema,
  aspectRatios: ['9:16', '16:9', '1:1'],
  animations: ['fade-up', 'scale'],
  transitions: ['soft-push'],
  defaults: {
    theme: 'tech-blue',
    font: 'source-han-sans',
    background: 'dark-grid',
    transition: 'soft-push',
    textDensity: 'standard',
  },
} as const satisfies TextVideoTemplateManifest<TechTextV1Props>
