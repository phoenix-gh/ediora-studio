import { describe, expect, it } from 'vitest'

import {
  CONTINUITY_EPSILON_SECONDS,
  parseTextVideoRenderInput,
  parseTextVideoRenderInputWithManifest,
} from './contract'
import { findActiveTextVideoSegment } from './templates/tech-text-v1/Composition'
import type { TextVideoTemplateManifest } from './types'
import { z } from 'zod'

const validInput = {
  templateId: 'tech-text-v1',
  templateVersion: 1,
  composition: {
    width: 1080,
    height: 1920,
    fps: 30,
  },
  audio: 'voice.mp3',
  segments: [
    {
      id: 'scene-1',
      start: 0,
      end: 2.4,
      text: '做 AI 视频的',
      highlight: ['AI'],
      animation: 'fade-up',
    },
    {
      id: 'scene-2',
      start: 2.4,
      end: 4.2,
      text: '一个月没赚到钱',
      highlight: ['没赚到钱'],
      animation: 'scale',
    },
  ],
  templateProps: {
    theme: 'tech-blue',
    font: 'source-han-sans',
    background: 'dark-grid',
    transition: 'soft-push',
    textDensity: 'standard',
  },
}

function parse(value: unknown, masterDuration = 4.2) {
  return parseTextVideoRenderInput(value, { masterDuration })
}

describe('text-video render contract', () => {
  it('accepts a valid versioned render input', () => {
    expect(parse(validInput)).toEqual(validInput)
    expect(CONTINUITY_EPSILON_SECONDS).toBe(0.001)
  })

  it.each([
    [
      'starts after zero',
      [{ ...validInput.segments[0], start: 0.1 }, validInput.segments[1]],
    ],
    [
      'contains a gap',
      [validInput.segments[0], { ...validInput.segments[1], start: 2.5 }],
    ],
    [
      'contains an overlap',
      [validInput.segments[0], { ...validInput.segments[1], start: 2.3 }],
    ],
    [
      'ends before audio',
      [validInput.segments[0], { ...validInput.segments[1], end: 4.1 }],
    ],
  ])('rejects a timeline that %s', (_name, segments) => {
    expect(() => parse({ ...validInput, segments }))
      .toThrow('segments must continuously cover the master audio')
  })

  it('uses a 0.001 second continuity epsilon', () => {
    const toleratedInput = {
      ...validInput,
      segments: [
        { ...validInput.segments[0], start: 0.0009 },
        { ...validInput.segments[1], start: 2.4009, end: 4.2009 },
      ],
    }

    expect(() => parse(toleratedInput)).not.toThrow()
    expect(findActiveTextVideoSegment(toleratedInput.segments, 0).id)
      .toBe('scene-1')
    expect(findActiveTextVideoSegment(toleratedInput.segments, 2.4).id)
      .toBe('scene-2')
    expect(() => findActiveTextVideoSegment(
      toleratedInput.segments,
      4.2009,
    )).toThrow('没有对应的连续分镜')

    expect(() => parse({
      ...validInput,
      segments: [
        { ...validInput.segments[0], start: 0.0011 },
        validInput.segments[1],
      ],
    })).toThrow('segments must continuously cover the master audio')
  })

  it.each([
    [{ templateVersion: 2 }, 'tech-text-v1@2'],
    [{ templateId: 'missing-template' }, 'missing-template@1'],
  ])('fails closed for an unknown template pair', (template, pair) => {
    expect(() => parse({ ...validInput, ...template })).toThrow(pair)
  })

  it('validates aspect ratio, animation, transition and props from the manifest', () => {
    expect(() => parse({
      ...validInput,
      composition: { ...validInput.composition, width: 1200, height: 900 },
    })).toThrow('composition must use a supported aspect ratio')

    expect(() => parse({
      ...validInput,
      segments: [
        { ...validInput.segments[0], animation: 'spin' },
        validInput.segments[1],
      ],
    })).toThrow('animation')

    expect(() => parse({
      ...validInput,
      templateProps: { ...validInput.templateProps, transition: 'wipe' },
    })).toThrow('transition')

    expect(() => parse({
      ...validInput,
      templateProps: { ...validInput.templateProps, extra: true },
    })).toThrow()
  })

  it('lets a heterogeneous manifest own its props schema and composition', () => {
    const horizontalManifest = {
      id: 'horizontal-color-v1',
      version: 1,
      compositionId: 'horizontal-color-v1',
      component: () => null,
      propsSchema: z.object({ color: z.string() }).strict(),
      defaultComposition: { width: 1920, height: 1080, fps: 30 },
      aspectRatios: ['16:9'],
      animations: ['fade-up', 'scale'],
      transitions: ['crossfade'],
      defaults: { color: 'cyan' },
    } satisfies TextVideoTemplateManifest<{ color: string }>
    const horizontalInput = {
      ...validInput,
      templateId: horizontalManifest.id,
      composition: horizontalManifest.defaultComposition,
      templateProps: horizontalManifest.defaults,
    }

    expect(parseTextVideoRenderInputWithManifest(horizontalInput, {
      masterDuration: 4.2,
      manifest: horizontalManifest,
    })).toEqual(horizontalInput)
  })

  it('rejects duplicate ids, blank text, and highlights outside scene text', () => {
    expect(() => parse({
      ...validInput,
      segments: [
        validInput.segments[0],
        { ...validInput.segments[1], id: 'scene-1' },
      ],
    })).toThrow('segment ids must be unique')

    expect(() => parse({
      ...validInput,
      segments: [
        { ...validInput.segments[0], text: ' ' },
        validInput.segments[1],
      ],
    })).toThrow('segment text must not be blank')

    expect(() => parse({
      ...validInput,
      segments: [
        { ...validInput.segments[0], highlight: ['不存在'] },
        validInput.segments[1],
      ],
    })).toThrow('highlight must occur in segment text')
  })

  it('rejects unknown envelope and segment fields', () => {
    expect(() => parse({ ...validInput, masterDuration: 4.2 })).toThrow()
    expect(() => parse({
      ...validInput,
      segments: [
        { ...validInput.segments[0], fromWordId: 'word-1' },
        validInput.segments[1],
      ],
    })).toThrow()
  })

  it('requires a finite positive authoritative duration', () => {
    expect(() => parseTextVideoRenderInput(validInput, { masterDuration: 0 }))
      .toThrow('master duration must be finite and positive')
    expect(() => parseTextVideoRenderInput(validInput, { masterDuration: Number.NaN }))
      .toThrow('master duration must be finite and positive')
  })

  it('rejects non-finite segment seconds', () => {
    expect(() => parse({
      ...validInput,
      segments: [
        { ...validInput.segments[0], start: Number.NaN },
        validInput.segments[1],
      ],
    })).toThrow()
    expect(() => parse({
      ...validInput,
      segments: [
        validInput.segments[0],
        { ...validInput.segments[1], end: Number.POSITIVE_INFINITY },
      ],
    })).toThrow()
  })

  it('never falls back to the final scene when no scene covers a frame', () => {
    expect(() => findActiveTextVideoSegment(validInput.segments, 4.2))
      .toThrow('没有对应的连续分镜')
  })
})
