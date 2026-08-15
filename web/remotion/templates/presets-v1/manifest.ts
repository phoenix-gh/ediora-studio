import type { TextVideoTemplateManifest } from '../../types'
import { PresetTextComposition } from './Composition'
import {
  CAPTION_FOCUS_DEFAULTS,
  captionFocusPropsSchema,
  EDITORIAL_CARD_DEFAULTS,
  editorialCardPropsSchema,
  KINETIC_PUNCH_DEFAULTS,
  kineticPunchPropsSchema,
  PRESET_TEXT_SETTINGS,
  VOICE_PULSE_DEFAULTS,
  voicePulsePropsSchema,
  type CaptionFocusProps,
  type EditorialCardProps,
  type KineticPunchProps,
  type VoicePulseProps,
} from './config'

const shared = {
  version: 1,
  defaultComposition: { width: 1080, height: 1920, fps: 30 },
  aspectRatios: ['9:16', '16:9', '1:1'],
  transitions: ['cut'],
  settings: PRESET_TEXT_SETTINGS,
} as const

export const kineticPunchV1Manifest = {
  ...shared,
  id: 'kinetic-punch-v1',
  compositionId: 'kinetic-punch-v1',
  name: '动感大字',
  description: '高对比色块、超大场景编号与冲击式文字入场',
  component: PresetTextComposition,
  propsSchema: kineticPunchPropsSchema,
  animations: ['scale', 'fade-up'],
  defaults: KINETIC_PUNCH_DEFAULTS,
} as const satisfies TextVideoTemplateManifest<KineticPunchProps>

export const captionFocusV1Manifest = {
  ...shared,
  id: 'caption-focus-v1',
  compositionId: 'caption-focus-v1',
  name: '逐词聚焦字幕',
  description: '短视频字幕卡、关键词聚焦与清晰的信息层级',
  component: PresetTextComposition,
  propsSchema: captionFocusPropsSchema,
  animations: ['fade-up', 'scale'],
  defaults: CAPTION_FOCUS_DEFAULTS,
} as const satisfies TextVideoTemplateManifest<CaptionFocusProps>

export const editorialCardV1Manifest = {
  ...shared,
  id: 'editorial-card-v1',
  compositionId: 'editorial-card-v1',
  name: '杂志卡片',
  description: '留白纸张、衬线排版与适合观点表达的编辑风格',
  component: PresetTextComposition,
  propsSchema: editorialCardPropsSchema,
  animations: ['fade-up', 'scale'],
  defaults: EDITORIAL_CARD_DEFAULTS,
} as const satisfies TextVideoTemplateManifest<EditorialCardProps>

export const voicePulseV1Manifest = {
  ...shared,
  id: 'voice-pulse-v1',
  compositionId: 'voice-pulse-v1',
  name: '声波脉冲',
  description: '音频节目式光环、动态波形与沉浸式口播字幕',
  component: PresetTextComposition,
  propsSchema: voicePulsePropsSchema,
  animations: ['scale', 'fade-up'],
  defaults: VOICE_PULSE_DEFAULTS,
} as const satisfies TextVideoTemplateManifest<VoicePulseProps>

export {
  CAPTION_FOCUS_DEFAULTS,
  EDITORIAL_CARD_DEFAULTS,
  KINETIC_PUNCH_DEFAULTS,
  PRESET_TEXT_SETTINGS,
  VOICE_PULSE_DEFAULTS,
}
