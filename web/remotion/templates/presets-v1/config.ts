import { z } from 'zod'

import type { TextVideoTemplateSettingGroup } from '../../types'

const basePresetPropsSchema = z.object({
  palette: z.enum(['night', 'light', 'warm']),
  brandTitle: z.string().trim().max(32),
  showBrand: z.boolean(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
  showProgress: z.boolean(),
})

export const kineticPunchPropsSchema = basePresetPropsSchema.extend({
  style: z.literal('kinetic-punch'),
}).strict()

export const captionFocusPropsSchema = basePresetPropsSchema.extend({
  style: z.literal('caption-focus'),
}).strict()

export const editorialCardPropsSchema = basePresetPropsSchema.extend({
  style: z.literal('editorial-card'),
}).strict()

export const voicePulsePropsSchema = basePresetPropsSchema.extend({
  style: z.literal('voice-pulse'),
}).strict()

export type KineticPunchProps = z.infer<typeof kineticPunchPropsSchema>
export type CaptionFocusProps = z.infer<typeof captionFocusPropsSchema>
export type EditorialCardProps = z.infer<typeof editorialCardPropsSchema>
export type VoicePulseProps = z.infer<typeof voicePulsePropsSchema>
export type PresetTextProps =
  | KineticPunchProps
  | CaptionFocusProps
  | EditorialCardProps
  | VoicePulseProps

export const KINETIC_PUNCH_DEFAULTS = {
  style: 'kinetic-punch',
  palette: 'night',
  brandTitle: 'EDIORA',
  showBrand: true,
  accentColor: '#D8FF3E',
  showProgress: true,
} as const satisfies KineticPunchProps

export const CAPTION_FOCUS_DEFAULTS = {
  style: 'caption-focus',
  palette: 'night',
  brandTitle: 'EDIORA',
  showBrand: true,
  accentColor: '#FF4D8D',
  showProgress: true,
} as const satisfies CaptionFocusProps

export const EDITORIAL_CARD_DEFAULTS = {
  style: 'editorial-card',
  palette: 'light',
  brandTitle: 'EDIORA JOURNAL',
  showBrand: true,
  accentColor: '#D14B32',
  showProgress: true,
} as const satisfies EditorialCardProps

export const VOICE_PULSE_DEFAULTS = {
  style: 'voice-pulse',
  palette: 'warm',
  brandTitle: 'EDIORA VOICE',
  showBrand: true,
  accentColor: '#7C5CFF',
  showProgress: true,
} as const satisfies VoicePulseProps

export const PRESET_TEXT_SETTINGS = [
  {
    id: 'identity',
    label: '品牌',
    fields: [
      {
        key: 'brandTitle',
        kind: 'text',
        label: '品牌标题',
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
        key: 'palette',
        kind: 'select',
        label: '色调',
        options: [
          { value: 'night', label: '深夜' },
          { value: 'light', label: '明亮' },
          { value: 'warm', label: '暖色' },
        ],
      },
      {
        key: 'showProgress',
        kind: 'boolean',
        label: '显示播放进度',
      },
    ],
  },
] as const satisfies readonly TextVideoTemplateSettingGroup<PresetTextProps>[]
