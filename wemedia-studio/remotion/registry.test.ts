import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import type { TextVideoTemplateManifest } from './types'
import {
  createTextVideoTemplateRegistry,
  resolveTextVideoTemplate,
  textVideoTemplates,
} from './registry'

describe('text-video template registry', () => {
  it('resolves the exact registered id and version', () => {
    expect(resolveTextVideoTemplate('tech-text-v1', 1)).toMatchObject({
      id: 'tech-text-v1',
      version: 1,
      compositionId: 'tech-text-v1',
      aspectRatios: ['9:16', '16:9', '1:1'],
      animations: ['fade-up', 'scale'],
      transitions: ['soft-push'],
      defaults: {
        theme: 'tech-blue',
        font: 'source-han-sans',
        background: 'dark-grid',
        transition: 'soft-push',
        textDensity: 'standard',
      },
    })
    expect(textVideoTemplates).toHaveLength(1)
  })

  it.each([
    ['tech-text-v1', 2],
    ['missing-template', 1],
  ])('rejects unknown template pair %s@%s', (id, version) => {
    expect(() => resolveTextVideoTemplate(id, version))
      .toThrow(`未知文字视频模板：${id}@${version}`)
  })

  it('rejects duplicate registry keys and composition ids', () => {
    const component = () => null
    const manifest = {
      id: 'example',
      version: 1,
      compositionId: 'example-v1',
      component,
      propsSchema: z.object({ color: z.string() }).strict(),
      aspectRatios: ['9:16'],
      animations: ['fade-up'],
      transitions: ['soft-push'],
      defaults: { color: 'blue' },
    } satisfies TextVideoTemplateManifest<{ color: string }>

    expect(() => createTextVideoTemplateRegistry([
      manifest,
      { ...manifest },
    ])).toThrow('重复文字视频模板：example@1')

    expect(() => createTextVideoTemplateRegistry([
      manifest,
      {
        ...manifest,
        id: 'other',
        compositionId: manifest.compositionId,
      },
    ])).toThrow('重复 Remotion compositionId：example-v1')
  })
})
