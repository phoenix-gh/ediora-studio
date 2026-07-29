import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import {
  createTextVideoCompositionRegistrations,
  createTextVideoDefaultRenderInput,
} from './Root'
import { techTextV1Manifest } from './templates/tech-text-v1/manifest'
import type { TextVideoTemplateManifest } from './types'

describe('text-video Remotion registration', () => {
  it('uses each manifest default composition instead of a portrait fallback', () => {
    const horizontalManifest = {
      id: 'horizontal-color-v1',
      version: 1,
      compositionId: 'horizontal-color-v1',
      component: () => null,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1920, height: 1080, fps: 24 },
      aspectRatios: ['16:9'],
      animations: ['fade-up'],
      transitions: ['crossfade'],
      defaults: { color: 'cyan' },
    } as const satisfies TextVideoTemplateManifest<{ color: string }>

    expect(createTextVideoDefaultRenderInput(horizontalManifest)).toMatchObject({
      composition: { width: 1920, height: 1080, fps: 24 },
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
      fps: 24,
    })
  })
})
