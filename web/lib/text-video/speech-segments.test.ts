import { describe, expect, it } from 'vitest'

import { makeMasterAudio, makeScenePlan, makeSpeechSegment, makeTextVideoProject } from './test-fixtures'
import {
  applySpeechSplitProposal,
  collapseToSingleSegment,
  editSpeechSegment,
  estimateSpeechDuration,
  mergeSpeechSegment,
  reorderSpeechSegment,
  splitSpeechSegment,
} from './speech-segments'


describe('lossless speech segment operations', () => {
  it('splits at the exact JS cursor without losing whitespace', () => {
    const script = '第一句。\n  第二句。'
    const project = makeTextVideoProject({
      script,
      paragraphs: [makeSpeechSegment('segment-1', script)],
    })

    const next = splitSpeechSegment(project, 'segment-1', 5)

    expect(next.paragraphs.map(item => item.text)).toEqual(['第一句。\n', '  第二句。'])
    expect(next.paragraphs.map(item => item.text).join('')).toBe(next.script)
    expect(next.paragraphs[0].id).toBe('segment-1')
    expect(next.paragraphs[1].id).not.toBe('segment-1')
    expect(next.speech_split_mode).toBe('manual')
  })

  it('merges adjacent segments and invalidates only the merged speech', () => {
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('segment-1', '甲。', { status: 'confirmed' }),
        makeSpeechSegment('segment-2', '乙。', { status: 'confirmed' }),
      ],
      master_audio: makeMasterAudio({ status: 'ready', timeline_status: 'ready' }),
      scene_plan: makeScenePlan({ status: 'ready' }),
    })

    const next = mergeSpeechSegment(project, 'segment-2', 'previous')

    expect(next.paragraphs).toHaveLength(1)
    expect(next.paragraphs[0]).toMatchObject({
      id: 'segment-1',
      text: '甲。乙。',
      status: 'draft',
      generation_revision: 1,
    })
    expect(next.master_audio.status).toBe('stale')
    expect(next.master_audio.timeline_status).toBe('stale')
    expect(next.scene_plan.status).toBe('stale')
    expect(next.script).toBe('甲。乙。')
  })

  it('rejects a whitespace-only side of a split', () => {
    const project = makeTextVideoProject({
      script: '甲。  ',
      paragraphs: [makeSpeechSegment('segment-1', '甲。  ')],
    })

    expect(() => splitSpeechSegment(project, 'segment-1', 2))
      .toThrow('分段后不能只包含空白')
  })

  it('edits one segment without mutating visual scenes by paragraph index', () => {
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('segment-1', '甲。', { status: 'confirmed' }),
        makeSpeechSegment('segment-2', '乙。', { status: 'confirmed' }),
      ],
    })
    const originalScenes = project.render_input.segments

    const next = editSpeechSegment(project, 'segment-2', '乙改。')

    expect(next.script).toBe('甲。乙改。')
    expect(next.paragraphs[0].status).toBe('confirmed')
    expect(next.paragraphs[1]).toMatchObject({
      text: '乙改。',
      status: 'draft',
      generation_revision: 1,
    })
    expect(next.render_input.segments).toEqual(originalScenes)
    expect(project.paragraphs[1].text).toBe('乙。')
  })

  it('reorders exact slices while preserving reusable segment speech', () => {
    const project = makeTextVideoProject({
      script: '甲。乙。丙。',
      speech_split_mode: 'manual',
      paragraphs: [
        makeSpeechSegment('a', '甲。', { status: 'confirmed' }),
        makeSpeechSegment('b', '乙。', { status: 'confirmed' }),
        makeSpeechSegment('c', '丙。', { status: 'confirmed' }),
      ],
      master_audio: makeMasterAudio({ status: 'ready', timeline_status: 'ready' }),
    })

    const next = reorderSpeechSegment(project, 'c', 0)

    expect(next.paragraphs.map(item => item.id)).toEqual(['c', 'a', 'b'])
    expect(next.paragraphs.every(item => item.status === 'confirmed')).toBe(true)
    expect(next.script).toBe('丙。甲。乙。')
    expect(next.master_audio.status).toBe('stale')
  })

  it('collapses all slices into one exact draft segment', () => {
    const project = makeTextVideoProject({
      script: '甲。\n乙。',
      speech_split_mode: 'manual',
      paragraphs: [
        makeSpeechSegment('a', '甲。\n', { status: 'confirmed' }),
        makeSpeechSegment('b', '乙。', { status: 'confirmed' }),
      ],
    })

    const next = collapseToSingleSegment(project)

    expect(next.paragraphs).toHaveLength(1)
    expect(next.paragraphs[0]).toMatchObject({
      id: 'a',
      text: '甲。\n乙。',
      status: 'draft',
    })
    expect(next.speech_split_mode).toBe('single')
    expect(next.script).toBe(project.script)
  })

  it('applies only an exact AI split proposal and preserves unchanged generated slices', () => {
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。', { status: 'confirmed' }),
        makeSpeechSegment('b', '乙。', { status: 'confirmed' }),
      ],
    })

    const next = applySpeechSplitProposal(project, {
      speech_split_mode: 'auto',
      segments: [
        { id: 'a', text: '甲。' },
        { id: 'new-boundary', text: '乙。' },
      ],
    })

    expect(next.speech_split_mode).toBe('auto')
    expect(next.paragraphs[0].status).toBe('confirmed')
    expect(next.paragraphs[1]).toMatchObject({
      id: 'new-boundary',
      text: '乙。',
      status: 'draft',
    })
    expect(() => applySpeechSplitProposal(project, {
      speech_split_mode: 'auto',
      segments: [{ id: 'rewritten', text: '甲被改写。乙。' }],
    })).toThrow('AI 分段必须无损还原当前稿件')
  })

  it('does not stale downstream audio when an AI proposal changes no slices', () => {
    const paragraphs = [
      makeSpeechSegment('a', '甲。', { status: 'confirmed' }),
      makeSpeechSegment('b', '乙。', { status: 'confirmed' }),
    ]
    const project = makeTextVideoProject({
      script: '甲。乙。',
      speech_split_mode: 'manual',
      paragraphs,
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
      }),
      scene_plan: makeScenePlan({ status: 'ready' }),
    })

    const next = applySpeechSplitProposal(project, {
      speech_split_mode: 'auto',
      segments: paragraphs.map(({ id, text }) => ({ id, text })),
    })

    expect(next.master_audio.status).toBe('ready')
    expect(next.scene_plan.status).toBe('ready')
    expect(next.speech_split_mode).toBe('auto')
  })

  it('rounds display-only speech estimates with a half-second minimum', () => {
    expect(estimateSpeechDuration('甲。')).toBe(0.5)
    expect(estimateSpeechDuration('一二三四五六七八九十')).toBe(2.4)
  })
})
