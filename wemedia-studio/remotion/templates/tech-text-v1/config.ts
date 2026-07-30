import { z } from 'zod'

import type { TextVideoTemplateSettingGroup } from '../../types'

export const techTextV1PropsSchema = z.object({
  theme: z.literal('tech-blue'),
  font: z.literal('source-han-sans'),
  background: z.enum(['dark-grid', 'deep-space', 'clean-gradient']),
  transition: z.literal('soft-push'),
  textDensity: z.enum(['compact', 'standard', 'spacious']),
  brandTitle: z.string().trim().max(32).default('EDIORA'),
  brandSubtitle: z.string().trim().max(32).default('述策'),
  showBrand: z.boolean().default(true),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u).default('#69F6FF'),
  showProgress: z.boolean().default(true),
  showSceneNumber: z.boolean().default(true),
}).strict()

export type TechTextV1Props = z.infer<typeof techTextV1PropsSchema>

export const TECH_TEXT_V1_DEFAULTS = {
  theme: 'tech-blue',
  font: 'source-han-sans',
  background: 'dark-grid',
  transition: 'soft-push',
  textDensity: 'standard',
  brandTitle: 'EDIORA',
  brandSubtitle: '述策',
  showBrand: true,
  accentColor: '#69F6FF',
  showProgress: true,
  showSceneNumber: true,
} as const satisfies TechTextV1Props

export const TECH_TEXT_V1_SETTINGS = [
  {
    id: 'brand',
    label: '品牌',
    fields: [
      {
        key: 'brandTitle',
        kind: 'text',
        label: '品牌标题',
        maxLength: 32,
      },
      {
        key: 'brandSubtitle',
        kind: 'text',
        label: '品牌副标题',
        maxLength: 32,
      },
      {
        key: 'showBrand',
        kind: 'boolean',
        label: '显示品牌',
      },
      {
        key: 'accentColor',
        kind: 'color',
        label: '强调色',
      },
    ],
  },
  {
    id: 'appearance',
    label: '画面',
    fields: [
      {
        key: 'background',
        kind: 'select',
        label: '背景',
        options: [
          { value: 'dark-grid', label: '深色网格' },
          { value: 'deep-space', label: '深空' },
          { value: 'clean-gradient', label: '简洁渐变' },
        ],
      },
      {
        key: 'textDensity',
        kind: 'select',
        label: '文字密度',
        options: [
          { value: 'compact', label: '紧凑' },
          { value: 'standard', label: '标准' },
          { value: 'spacious', label: '宽松' },
        ],
      },
      {
        key: 'showProgress',
        kind: 'boolean',
        label: '显示进度',
      },
      {
        key: 'showSceneNumber',
        kind: 'boolean',
        label: '显示场景编号',
      },
    ],
  },
] as const satisfies readonly TextVideoTemplateSettingGroup<TechTextV1Props>[]
