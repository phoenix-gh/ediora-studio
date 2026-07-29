import type { TechTextV1Props } from '../../contract'

export const TECH_TEXT_V1_ID = 'tech-text-v1'

export const techTextV1Manifest = {
  id: TECH_TEXT_V1_ID,
  name: '科技资讯动态文字',
  description: '深色科技网格、关键词高亮与节奏化文字转场',
  version: 1,
  aspectRatios: ['9:16', '16:9', '1:1'] as const,
  animations: ['fade-up', 'scale'] as const,
  defaults: {
    theme: 'tech-blue',
    font: 'source-han-sans',
    background: 'dark-grid',
    transition: 'soft-push',
    textDensity: 'standard',
  } satisfies TechTextV1Props,
} as const
