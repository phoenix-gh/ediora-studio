import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import type { TextVideoTemplateManifest } from './types'
import {
  createTextVideoTemplateRegistry,
  resolveTextVideoTemplate,
  textVideoTemplates,
} from './registry'
import { techTextV1Manifest } from './templates/tech-text-v1/manifest'

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
        brandTitle: 'EDIORA',
        brandSubtitle: '述策',
        showBrand: true,
        accentColor: '#69F6FF',
        showProgress: true,
        showSceneNumber: true,
      },
      settings: expect.any(Array),
    })
    expect(textVideoTemplates).toHaveLength(5)
    expect(textVideoTemplates.map(template => template.id)).toEqual([
      'tech-text-v1',
      'kinetic-punch-v1',
      'caption-focus-v1',
      'editorial-card-v1',
      'voice-pulse-v1',
    ])
  })

  it.each([
    ['kinetic-punch-v1', '动感大字'],
    ['caption-focus-v1', '逐词聚焦字幕'],
    ['editorial-card-v1', '杂志卡片'],
    ['voice-pulse-v1', '声波脉冲'],
  ])('registers the %s preset with editable settings', (id, name) => {
    const template = resolveTextVideoTemplate(id, 1)

    expect(template).toMatchObject({
      id,
      version: 1,
      compositionId: id,
      name,
      aspectRatios: ['9:16', '16:9', '1:1'],
      defaults: expect.any(Object),
      settings: expect.any(Array),
    })
    expect(template.settings.length).toBeGreaterThan(0)
  })

  it('locks the render-facing catalog contract for frontend/backend parity', () => {
    expect(textVideoTemplates.map(template => ({
      id: template.id,
      compositionId: template.compositionId,
      composition: template.defaultComposition,
      animations: template.animations,
      transitions: template.transitions,
      defaults: template.defaults,
    }))).toEqual([
      {
        id: 'tech-text-v1',
        compositionId: 'tech-text-v1',
        composition: { width: 1080, height: 1920, fps: 30 },
        animations: ['fade-up', 'scale'],
        transitions: ['soft-push'],
        defaults: {
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
        },
      },
      {
        id: 'kinetic-punch-v1',
        compositionId: 'kinetic-punch-v1',
        composition: { width: 1080, height: 1920, fps: 30 },
        animations: ['scale', 'fade-up'],
        transitions: ['cut'],
        defaults: {
          style: 'kinetic-punch',
          palette: 'night',
          brandTitle: 'EDIORA',
          showBrand: true,
          accentColor: '#D8FF3E',
          showProgress: true,
        },
      },
      {
        id: 'caption-focus-v1',
        compositionId: 'caption-focus-v1',
        composition: { width: 1080, height: 1920, fps: 30 },
        animations: ['fade-up', 'scale'],
        transitions: ['cut'],
        defaults: {
          style: 'caption-focus',
          palette: 'night',
          brandTitle: 'EDIORA',
          showBrand: true,
          accentColor: '#FF4D8D',
          showProgress: true,
        },
      },
      {
        id: 'editorial-card-v1',
        compositionId: 'editorial-card-v1',
        composition: { width: 1080, height: 1920, fps: 30 },
        animations: ['fade-up', 'scale'],
        transitions: ['cut'],
        defaults: {
          style: 'editorial-card',
          palette: 'light',
          brandTitle: 'EDIORA JOURNAL',
          showBrand: true,
          accentColor: '#D14B32',
          showProgress: true,
        },
      },
      {
        id: 'voice-pulse-v1',
        compositionId: 'voice-pulse-v1',
        composition: { width: 1080, height: 1920, fps: 30 },
        animations: ['scale', 'fade-up'],
        transitions: ['cut'],
        defaults: {
          style: 'voice-pulse',
          palette: 'warm',
          brandTitle: 'EDIORA VOICE',
          showBrand: true,
          accentColor: '#7C5CFF',
          showProgress: true,
        },
      },
    ])
  })

  it.each([
    ['tech-text-v1', 2],
    ['missing-template', 1],
  ])('rejects unknown template pair %s@%s', (id, version) => {
    expect(() => resolveTextVideoTemplate(id, version))
      .toThrow(`未知文字视频模板：${id}@${version}`)
  })

  it.each([
    ['tech-text-v1', '1'],
    ['tech-text-v1', new Number(1)],
    ['tech-text-v1', Number.NaN],
    ['tech-text-v1', Number.POSITIVE_INFINITY],
    ['tech-text-v1', 0],
  ])('rejects non-primitive or invalid runtime identity %s@%s', (id, version) => {
    expect(() => resolveTextVideoTemplate(
      id as unknown as string,
      version as unknown as number,
    )).toThrow('未知文字视频模板')
  })

  it('rejects duplicate registry keys and composition ids', () => {
    const component = () => null
    const manifest = {
      id: 'example',
      version: 1,
      compositionId: 'example-v1',
      component,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1920, height: 1080, fps: 30 },
      aspectRatios: ['9:16'],
      animations: ['fade-up'],
      transitions: ['soft-push'],
      defaults: { color: 'blue' },
      settings: [],
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

  it('keeps heterogeneous manifests in one exact registry', () => {
    const horizontalManifest = {
      id: 'horizontal-color-v1',
      version: 1,
      compositionId: 'horizontal-color-v1',
      component: () => null,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1920, height: 1080, fps: 30 },
      aspectRatios: ['16:9'],
      animations: ['fade-up'],
      transitions: ['crossfade'],
      defaults: { color: 'cyan' },
      settings: [],
    } as const satisfies TextVideoTemplateManifest<{ color: string }>

    const registry = createTextVideoTemplateRegistry([
      techTextV1Manifest,
      horizontalManifest,
    ])

    expect(registry.get('tech-text-v1@1')).toBe(techTextV1Manifest)
    expect(registry.get('horizontal-color-v1@1')).toBe(horizontalManifest)
  })

  it('rejects duplicate setting keys', () => {
    const manifest = {
      id: 'duplicate-settings',
      version: 1,
      compositionId: 'duplicate-settings',
      component: () => null,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1080, height: 1920, fps: 30 },
      aspectRatios: ['9:16'],
      animations: ['fade-up'],
      transitions: ['soft-push'],
      defaults: { color: '#69F6FF' },
      settings: [{
        id: 'appearance',
        label: '外观',
        fields: [
          { key: 'color', kind: 'color', label: '强调色' },
          { key: 'color', kind: 'text', label: '颜色', maxLength: 7 },
        ],
      }],
    } as const satisfies TextVideoTemplateManifest<{ color: string }>

    expect(() => createTextVideoTemplateRegistry([manifest]))
      .toThrow('重复模板设置字段：color')
  })

  it('rejects setting keys missing from manifest defaults', () => {
    const manifest = {
      id: 'missing-setting-default',
      version: 1,
      compositionId: 'missing-setting-default',
      component: () => null,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1080, height: 1920, fps: 30 },
      aspectRatios: ['9:16'],
      animations: ['fade-up'],
      transitions: ['soft-push'],
      defaults: { color: '#69F6FF' },
      settings: [{
        id: 'appearance',
        label: '外观',
        fields: [
          { key: 'missing', kind: 'color', label: '强调色' },
        ],
      }],
    } as unknown as TextVideoTemplateManifest<{ color: string }>

    expect(() => createTextVideoTemplateRegistry([manifest]))
      .toThrow('模板设置字段缺少默认值：missing')
  })
})
