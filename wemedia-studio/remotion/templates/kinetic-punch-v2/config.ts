import { z } from 'zod'

import type { TextVideoTemplateSettingGroup } from '../../types'

export const kineticPunchV2PropsSchema = z.object({
  brandTitle: z.string().trim().max(40),
  showBrand: z.boolean(),
  accentColor: z.string().regex(/^#[0-9A-F]{6}$/iu),
  showProgress: z.boolean(),
  palette: z.enum(['night', 'light']),
}).strict()

export type KineticPunchV2Props = z.infer<
  typeof kineticPunchV2PropsSchema
>

export const KINETIC_PUNCH_V2_DEFAULTS = {
  brandTitle: 'EDIORA',
  showBrand: true,
  accentColor: '#D8FF3E',
  showProgress: true,
  palette: 'night',
} as const satisfies KineticPunchV2Props

export const KINETIC_PUNCH_V2_SETTINGS = [{
  id: 'brand',
  label: '品牌与画面',
  fields: [
    {
      key: 'brandTitle',
      kind: 'text',
      label: '左上角品牌',
      maxLength: 40,
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
    {
      key: 'showProgress',
      kind: 'boolean',
      label: '显示进度',
    },
    {
      key: 'palette',
      kind: 'select',
      label: '底色',
      options: [
        { value: 'night', label: '深色' },
        { value: 'light', label: '浅色' },
      ],
    },
  ],
}] as const satisfies readonly TextVideoTemplateSettingGroup<
  KineticPunchV2Props
>[]
