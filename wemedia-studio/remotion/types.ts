import type { ComponentType } from 'react'
import type { ZodType } from 'zod'

export const CONTINUITY_EPSILON_SECONDS = 0.001

export type TextVideoAspectRatio = '9:16' | '16:9' | '1:1'

export type TextVideoComposition = {
  width: number
  height: number
  fps: number
}

export type KineticWordCue = {
  text: string
  start: number
  end: number
  emphasis: 'normal' | 'highlight'
}

export type KineticRenderChunk = {
  id: string
  start: number
  end: number
  text: string
  motionPreset: 'impact' | 'reveal' | 'contrast'
  emphasis: 'normal' | 'punch'
  words: KineticWordCue[]
}

export type TextVideoSegment = {
  id: string
  start: number
  end: number
  text: string
  highlight: string[]
  animation: string
  transition?: 'block-wipe'
  intensity?: number
  chunks?: KineticRenderChunk[]
}

export type TextVideoRenderInput<P = Record<string, unknown>> = {
  templateId: string
  templateVersion: number
  composition: TextVideoComposition
  audio: string
  segments: TextVideoSegment[]
  templateProps: P
}

export type TextVideoTemplateSettingField<P> =
  | {
    key: Extract<keyof P, string>
    kind: 'text'
    label: string
    maxLength: number
  }
  | {
    key: Extract<keyof P, string>
    kind: 'boolean'
    label: string
  }
  | {
    key: Extract<keyof P, string>
    kind: 'select'
    label: string
    options: readonly { value: string; label: string }[]
  }
  | {
    key: Extract<keyof P, string>
    kind: 'color'
    label: string
  }

export type TextVideoTemplateSettingGroup<P> = {
  id: string
  label: string
  fields: readonly TextVideoTemplateSettingField<P>[]
}

export type TextVideoTemplateManifest<
  P extends Record<string, unknown>,
> = {
  id: string
  version: number
  compositionId: string
  name?: string
  description?: string
  component: ComponentType<TextVideoRenderInput<P>>
  propsSchema: ZodType<P>
  defaultComposition: Readonly<TextVideoComposition>
  aspectRatios: readonly TextVideoAspectRatio[]
  animations: readonly string[]
  transitions: readonly string[]
  defaults: P
  settings: readonly TextVideoTemplateSettingGroup<P>[]
}
