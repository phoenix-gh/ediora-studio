import type { ComponentType } from 'react'
import type { ZodType } from 'zod'

export const CONTINUITY_EPSILON_SECONDS = 0.001

export type TextVideoAspectRatio = '9:16' | '16:9' | '1:1'

export type TextVideoComposition = {
  width: number
  height: number
  fps: number
}

export type TextVideoSegment = {
  id: string
  start: number
  end: number
  text: string
  highlight: string[]
  animation: string
}

export type TextVideoRenderInput<P = Record<string, unknown>> = {
  templateId: string
  templateVersion: number
  composition: TextVideoComposition
  audio: string
  segments: TextVideoSegment[]
  templateProps: P
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
}
