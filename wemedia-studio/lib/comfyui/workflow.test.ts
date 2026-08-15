import { describe, expect, it } from 'vitest'

import { buildShotPrompt, h3Ref2vaPrompt } from './workflow'


describe('H3 Ref2VA prompt', () => {
  it('writes the official six sections and keeps Chinese dialogue', () => {
    const prompt = buildShotPrompt({
      framing: 'medium',
      spokenText: '今天只讲一件事。',
    })
    expect(prompt).toContain('Video Description:')
    expect(prompt).toContain('Camera Movement:')
    expect(prompt).toContain('Shot Type:')
    expect(prompt).toContain('Style:')
    expect(prompt).toContain('Subjects:')
    expect(prompt).toContain('Background:')
    expect(prompt).toContain('今天只讲一件事。')
    expect(prompt).toContain("Uses <Audio 1>'s voice.")
    expect(prompt).toContain('<Picture 1>')
    expect(prompt).toContain('<Picture 2>')
    expect(prompt).not.toContain('5s')
  })

  it('maps shared refs onto the pinned Ref2VA template', () => {
    const graph = h3Ref2vaPrompt({
      image_1: 'look.jpg',
      image_2: 'env.jpg',
      image_3: 'look.jpg',
      audio_1: 'voice.wav',
      prompt: 'Video Description:',
      duration: 5,
      seed: 7,
    }) as Record<string, { inputs?: Record<string, unknown> }>
    expect(graph['1']?.inputs?.image).toBe('look.jpg')
    expect(graph['2']?.inputs?.image).toBe('env.jpg')
    expect(graph['4']?.inputs?.audio).toBe('voice.wav')
    expect(graph['5']?.inputs?.length).toBe(5)
    expect(graph['5']?.inputs?.seed).toBe(7)
  })
})
