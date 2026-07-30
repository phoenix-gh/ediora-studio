import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import {
  createTextVideoCompositionRegistrations,
  createTextVideoDefaultRenderInput,
} from './Root'
import { techTextV1Manifest } from './templates/tech-text-v1/manifest'
import type {
  TextVideoRenderInput,
  TextVideoTemplateManifest,
} from './types'

describe('text-video Remotion registration', () => {
  it('uses each manifest default composition instead of a portrait fallback', () => {
    function HorizontalComponent({
      segments,
    }: TextVideoRenderInput<{ color: string }>) {
      const sceneAt = (seconds: number) => segments.find(
        segment => seconds >= segment.start && seconds < segment.end,
      )?.id ?? 'none'
      return createElement(
        'span',
        null,
        `${sceneAt(1.0005)}:${sceneAt(2)}`,
      )
    }

    const horizontalManifest = {
      id: 'horizontal-color-v1',
      version: 1,
      compositionId: 'horizontal-color-v1',
      component: HorizontalComponent,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1920, height: 1080, fps: 2000 },
      aspectRatios: ['16:9'],
      animations: ['fade-up'],
      transitions: ['crossfade'],
      defaults: { color: 'cyan' },
      settings: [],
    } as const satisfies TextVideoTemplateManifest<{ color: string }>

    expect(createTextVideoDefaultRenderInput(horizontalManifest)).toMatchObject({
      composition: { width: 1920, height: 1080, fps: 2000 },
      templateProps: { color: 'cyan' },
    })

    const registrations = createTextVideoCompositionRegistrations([
      techTextV1Manifest,
      horizontalManifest,
    ])
    expect(registrations.map(item => item.id)).toEqual([
      'tech-text-v1',
      'horizontal-color-v1',
    ])
    expect(registrations[1]).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 2000,
    })

    const rawProps = {
      ...createTextVideoDefaultRenderInput(horizontalManifest),
      segments: [
        {
          id: 'scene-1',
          start: 0.0009,
          end: 1,
          text: '第一幕',
          highlight: [],
          animation: 'fade-up',
        },
        {
          id: 'scene-2',
          start: 1.0009,
          end: 2,
          text: '第二幕',
          highlight: [],
          animation: 'fade-up',
        },
      ],
    }
    expect(renderToStaticMarkup(createElement(
      registrations[1].component,
      rawProps,
    ))).toContain('scene-2:none')
  })
})
