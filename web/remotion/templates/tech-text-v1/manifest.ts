import type { TextVideoTemplateManifest } from '../../types'
import {
  TECH_TEXT_V1_DEFAULTS,
  TECH_TEXT_V1_SETTINGS,
  techTextV1PropsSchema,
  type TechTextV1Props,
} from './config'
import { TechTextV1Composition } from './Composition'

export const TECH_TEXT_V1_ID = 'tech-text-v1'
export const TECH_TEXT_V1_VERSION = 1

export const techTextV1Manifest = {
  id: TECH_TEXT_V1_ID,
  version: TECH_TEXT_V1_VERSION,
  compositionId: TECH_TEXT_V1_ID,
  name: '科技资讯动态文字',
  description: '深色科技网格、关键词高亮与节奏化文字转场',
  component: TechTextV1Composition,
  propsSchema: techTextV1PropsSchema,
  defaultComposition: { width: 1080, height: 1920, fps: 30 },
  aspectRatios: ['9:16', '16:9', '1:1'],
  animations: ['fade-up', 'scale'],
  transitions: ['soft-push'],
  defaults: TECH_TEXT_V1_DEFAULTS,
  settings: TECH_TEXT_V1_SETTINGS,
} as const satisfies TextVideoTemplateManifest<TechTextV1Props>

export {
  TECH_TEXT_V1_DEFAULTS,
  TECH_TEXT_V1_SETTINGS,
  techTextV1PropsSchema,
}
export type { TechTextV1Props }
