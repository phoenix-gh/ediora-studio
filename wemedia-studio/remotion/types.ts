import type { ComponentType } from 'react'
import type { ZodType } from 'zod'

export type TextVideoAspectRatio = '9:16' | '16:9' | '1:1'

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
  composition: {
    width: number
    height: number
    fps: number
  }
  audio: string
  segments: TextVideoSegment[]
  templateProps: P
}

export type TextVideoTemplateManifest<P> = {
  id: string
  version: number
  compositionId: string
  name?: string
  description?: string
  component: ComponentType<TextVideoRenderInput<P>>
  propsSchema: ZodType<P>
  aspectRatios: readonly TextVideoAspectRatio[]
  animations: readonly string[]
  transitions: readonly string[]
  defaults: P
}
