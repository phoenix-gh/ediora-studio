import { describe, expect, it } from 'vitest'

import { buildShotPrompt, estimateShotSeconds, h3Ref2vaPrompt } from './workflow'


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
    expect(prompt).toContain('says ONLY this quoted line')
    expect(prompt).toContain('No extra words')
    expect(prompt).toContain('Uses <Audio 1> only as voice timbre.')
    expect(prompt).toContain('<d>[Chinese] 今天只讲一件事。</d>')
    expect(prompt).toContain('<Subject 1> (S1)')
    expect(prompt).toContain('<Picture 1>')
    expect(prompt).toContain('<Picture 2>')
    expect(prompt).toContain('Already talking at the first frame')
    expect(prompt).toContain('warm assured emotion')
    expect(prompt).toContain('medium conversational speaking rate')
    expect(prompt).toContain('one-hand open-palm beat on key words')
    expect(prompt).not.toContain('<Picture 3>')
    expect(prompt).not.toContain('5s')
  })

  it('tags English dialogue without forcing Chinese', () => {
    const prompt = buildShotPrompt({
      framing: 'medium',
      spokenText: 'Just one thing today.',
    })
    expect(prompt).toContain('<d>[English] Just one thing today.</d>')
  })

  it('prefers the shot delivery over the project base tone', () => {
    const prompt = buildShotPrompt({
      framing: 'medium',
      spokenText: '下一句',
      delivery: 'slower, emphasizes the caution',
      baseDelivery: 'calm tutorial host, medium pace',
    })
    expect(prompt).toContain('slower, emphasizes the caution')
    expect(prompt).not.toContain('calm tutorial host, medium pace')
  })

  it('uses the previous last frame as the next shot first frame', () => {
    const prompt = buildShotPrompt({
      framing: 'medium',
      spokenText: '下一句',
      hasFirstFrameReference: true,
    })
    expect(prompt).toContain('At 0.00 seconds, <Picture 3> is fully referenced as the first frame.')
    expect(prompt).toContain('last frame of the previous clip')
    expect(prompt).not.toContain('Already talking at the first frame')
  })

  it('estimates duration at five visible characters per second', () => {
    expect(estimateShotSeconds('短', 4, 5)).toBe(4)
    expect(estimateShotSeconds('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 4, 15)).toBe(10)
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
    expect(graph['137']?.inputs?.image).toBe('look.jpg')
    expect(graph['139']?.inputs?.image).toBe('env.jpg')
    expect(graph['142']?.inputs?.image).toBe('look.jpg')
    expect(graph['143']?.inputs?.audio).toBe('voice.wav')
    expect(graph['138']?.inputs?.value).toBe('Video Description:')
    expect(graph['132']?.inputs?.value).toBe(5)
    expect(graph['129']?.inputs?.noise_seed).toBe(7)
  })
})
