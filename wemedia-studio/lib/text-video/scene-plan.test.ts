import { describe, expect, it, vi } from 'vitest'

import type {
  GlobalWordTiming,
  ScenePlanDocument,
  ScenePlanSceneDocument,
  TextVideoProject,
} from '@/lib/api/text-videos'

import {
  applyScenePlanToProject,
  editSceneVisuals,
  mergeScene,
  moveSceneBoundary,
  sceneWordIds,
  splitSceneAtWord,
} from './scene-plan'

function words(tokens: string[]): GlobalWordTiming[] {
  return tokens.map((text, index) => ({
    id: `word-${index + 1}`,
    text,
    start: index * 0.4,
    end: (index + 1) * 0.4,
    speech_segment_id: 'speech-1',
  }))
}

function scene(
  id: string,
  fromWordId: string,
  throughWordId: string,
  displayText: string,
  highlight: string[] = [],
  animation = 'fade-up',
): ScenePlanSceneDocument {
  return {
    id,
    fromWordId,
    throughWordId,
    displayText,
    highlight,
    animation,
  }
}

function plan(scenes: ScenePlanSceneDocument[]): ScenePlanDocument {
  const value: ScenePlanDocument & { applied_job_id: number | null } = {
    status: 'ready',
    generation_revision: 3,
    master_source_hash: 'master-hash',
    scenes,
    job_id: null,
    error: '',
    applied_job_id: null,
  }
  return value
}

const timing = { masterDuration: 2.4, fps: 30 }

function twoScenePlan(): ScenePlanDocument {
  return plan([
    scene('scene-1', 'word-1', 'word-2', 'AI 文案', ['甲', '丙'], 'fade-up'),
    scene('scene-2', 'word-3', 'word-6', '旧的第二屏', ['丙', '己'], 'scale'),
  ])
}

function projectForVisualEdit(): TextVideoProject {
  const wordTimings = words(['甲', '乙'])
  return {
    id: 1,
    title: '场景编辑测试',
    status: 'audio_ready',
    stage: 'video',
    script: '甲乙',
    voice_settings: {
      voice_id: 'voice-1',
      model: 'mimo-v2.5-tts',
      speed: 1,
      volume: 1,
      pitch: 0,
    },
    paragraphs: [{
      id: 'speech-1',
      text: '甲乙',
      duration: 2,
      status: 'confirmed',
      audio_url: '/uploads/speech.mp3',
      word_timings: [
        { id: 'local-1', text: '甲', start: 0, end: 1 },
        { id: 'local-2', text: '乙', start: 1, end: 2 },
      ],
      source_hash: 'speech-hash',
      generation_revision: 1,
      error: '',
      job_id: null,
    }],
    speech_split_mode: 'single',
    master_audio: {
      status: 'ready',
      timeline_status: 'ready',
      asset_id: 91,
      audio_url: '/uploads/master.wav',
      duration: 2,
      sample_rate: 44_100,
      sample_count: 88_200,
      segment_offsets: [{
        segment_id: 'speech-1',
        asset_id: 90,
        sample_offset: 0,
        sample_count: 88_200,
      }],
      source_hash: 'master-hash',
      word_timings: wordTimings,
      timeline_source: 'provider',
      error: '',
      timeline_error: '',
      job_id: null,
      repair_generation: 0,
    },
    scene_plan: plan([
      scene('scene-1', 'word-1', 'word-1', '原屏显一', ['原'], 'fade-up'),
      scene('scene-2', 'word-2', 'word-2', '原屏显二', [], 'scale'),
    ]),
    render_input: {
      templateId: 'tech-text-v1',
      templateVersion: 1,
      composition: { width: 1080, height: 1920, fps: 30 },
      audio: '/uploads/master.wav',
      segments: [
        {
          id: 'scene-1',
          start: 0,
          end: 1,
          text: '原屏显一',
          highlight: ['原'],
          animation: 'fade-up',
        },
        {
          id: 'scene-2',
          start: 1,
          end: 2,
          text: '原屏显二',
          highlight: [],
          animation: 'scale',
        },
      ],
      templateProps: {
        theme: 'tech-blue',
        transition: 'soft-push',
      },
    },
    cover_asset_url: '',
    output_asset_url: '',
    output_stale: false,
    revision: 12,
    duration: 2,
    aspect_ratio: '9:16',
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z',
  }
}

describe('sceneWordIds', () => {
  it('returns every word ID once in timeline order for a complete partition', () => {
    const timeline = words(['甲', '乙', '丙', '丁', '戊', '己'])

    expect(sceneWordIds(twoScenePlan(), timeline)).toEqual([
      'word-1',
      'word-2',
      'word-3',
      'word-4',
      'word-5',
      'word-6',
    ])
  })

  it.each([
    {
      name: 'duplicates a word across adjacent scenes',
      scenes: [
        scene('scene-1', 'word-1', 'word-3', '甲乙丙'),
        scene('scene-2', 'word-3', 'word-6', '丙丁戊己'),
      ],
    },
    {
      name: 'skips a word between adjacent scenes',
      scenes: [
        scene('scene-1', 'word-1', 'word-2', '甲乙'),
        scene('scene-2', 'word-4', 'word-6', '丁戊己'),
      ],
    },
    {
      name: 'orders a range backwards',
      scenes: [
        scene('scene-1', 'word-1', 'word-4', '甲乙丙丁'),
        scene('scene-2', 'word-6', 'word-5', '己戊'),
      ],
    },
    {
      name: 'starts after the first word',
      scenes: [scene('scene-1', 'word-2', 'word-6', '乙丙丁戊己')],
    },
    {
      name: 'ends before the last word',
      scenes: [scene('scene-1', 'word-1', 'word-5', '甲乙丙丁戊')],
    },
    {
      name: 'references an unknown word',
      scenes: [scene('scene-1', 'word-1', 'missing-word', '甲乙丙丁戊己')],
    },
  ])('rejects a plan that $name', ({ scenes }) => {
    expect(() => sceneWordIds(plan(scenes), words(['甲', '乙', '丙', '丁', '戊', '己'])))
      .toThrow()
  })

  it('rejects duplicate scene IDs and duplicate timeline word IDs', () => {
    const timeline = words(['甲', '乙'])
    const duplicateSceneIds = plan([
      scene('scene-1', 'word-1', 'word-1', '甲'),
      scene('scene-1', 'word-2', 'word-2', '乙'),
    ])
    const duplicateWordIds = [
      timeline[0],
      { ...timeline[1], id: timeline[0].id },
    ]

    expect(() => sceneWordIds(duplicateSceneIds, timeline)).toThrow()
    expect(() => sceneWordIds(
      plan([scene('scene-1', 'word-1', 'word-1', '甲乙')]),
      duplicateWordIds,
    )).toThrow()
  })
})

describe('splitSceneAtWord', () => {
  it('keeps the left ID, creates one right ID, and recomputes exact token text', () => {
    const timeline = words(['甲', ' 乙', '丙', '丁', '戊', '己'])
    const original = {
      ...twoScenePlan(),
      applied_job_id: 71,
      job_id: 7001,
      error: '旧 AI 任务失败',
    }
    const snapshot = structuredClone(original)
    const createId = vi.fn(() => 'scene-new')

    const next = splitSceneAtWord(
      original,
      timeline,
      timing,
      'scene-1',
      'word-2',
      createId,
    )

    expect(createId).toHaveBeenCalledTimes(1)
    expect(next.generation_revision).toBe(original.generation_revision + 1)
    expect(next).toMatchObject({ applied_job_id: null })
    expect(next).toMatchObject({ job_id: null, error: '' })
    expect(next.scenes).toEqual([
      scene('scene-1', 'word-1', 'word-1', '甲', ['甲'], 'fade-up'),
      scene('scene-new', 'word-2', 'word-2', ' 乙', [], 'fade-up'),
      original.scenes[1],
    ])
    expect(sceneWordIds(next, timeline)).toEqual(timeline.map(word => word.id))
    expect(original).toEqual(snapshot)
  })

  it.each([
    ['the first word', 'word-1'],
    ['a word in another scene', 'word-3'],
    ['an unknown word', 'missing-word'],
  ])('rejects splitting at %s without allocating an ID', (_name, boundaryWordId) => {
    const createId = vi.fn(() => 'unused-id')

    expect(() => splitSceneAtWord(
      twoScenePlan(),
      words(['甲', '乙', '丙', '丁', '戊', '己']),
      timing,
      'scene-1',
      boundaryWordId,
      createId,
    )).toThrow()
    expect(createId).not.toHaveBeenCalled()
  })

  it('rejects unknown scenes and invalid generated IDs', () => {
    const timeline = words(['甲', '乙', '丙', '丁', '戊', '己'])
    const duplicateId = vi.fn(() => 'scene-2')

    expect(() => splitSceneAtWord(
      twoScenePlan(),
      timeline,
      timing,
      'missing-scene',
      'word-2',
      duplicateId,
    )).toThrow()
    expect(duplicateId).not.toHaveBeenCalled()

    expect(() => splitSceneAtWord(
      twoScenePlan(),
      timeline,
      timing,
      'scene-1',
      'word-2',
      duplicateId,
    )).toThrow()
    expect(duplicateId).toHaveBeenCalledTimes(1)
  })

  it('rejects a split whose new scene would start at a non-increasing second', () => {
    const timeline = words(['甲', '乙', '丙'])
    timeline[1] = { ...timeline[1], start: 0 }
    const original = plan([
      scene('scene-1', 'word-1', 'word-3', '甲乙丙'),
    ])
    const snapshot = structuredClone(original)
    const createId = vi.fn(() => 'scene-new')

    expect(() => splitSceneAtWord(
      original,
      timeline,
      timing,
      'scene-1',
      'word-2',
      createId,
    )).toThrow()
    expect(createId).toHaveBeenCalledTimes(1)
    expect(original).toEqual(snapshot)
  })

  it('uses master duration so trailing silence can keep the final scene positive', () => {
    const timeline: GlobalWordTiming[] = [
      {
        id: 'word-1',
        text: '甲',
        start: 0,
        end: 0.5,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-2',
        text: '乙',
        start: 1,
        end: 1,
        speech_segment_id: 'speech-1',
      },
    ]

    const next = splitSceneAtWord(
      plan([scene('scene-1', 'word-1', 'word-2', '甲乙')]),
      timeline,
      { masterDuration: 2, fps: 30 },
      'scene-1',
      'word-2',
      () => 'scene-new',
    )

    expect(next.scenes).toHaveLength(2)
    expect(next.scenes[1]).toMatchObject({
      id: 'scene-new',
      fromWordId: 'word-2',
      throughWordId: 'word-2',
    })
  })

  it('rejects a split when any projected scene contains no frame', () => {
    const timeline: GlobalWordTiming[] = [
      {
        id: 'word-1',
        text: '甲',
        start: 0,
        end: 0.005,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-2',
        text: '乙',
        start: 0.01,
        end: 0.015,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-3',
        text: '丙',
        start: 0.02,
        end: 0.025,
        speech_segment_id: 'speech-1',
      },
    ]
    const original = plan([
      scene('scene-1', 'word-1', 'word-3', '甲乙丙'),
    ])
    const snapshot = structuredClone(original)

    expect(() => splitSceneAtWord(
      original,
      timeline,
      { masterDuration: 0.03, fps: 30 },
      'scene-1',
      'word-2',
      () => 'scene-new',
    )).toThrow()
    expect(original).toEqual(snapshot)

    expect(splitSceneAtWord(
      original,
      timeline,
      { masterDuration: 0.03, fps: 100 },
      'scene-1',
      'word-2',
      () => 'scene-new',
    ).scenes).toHaveLength(2)
  })

  it('rejects a consecutive split before it can create a subframe scene', () => {
    const timeline: GlobalWordTiming[] = [
      {
        id: 'word-1',
        text: '甲',
        start: 0,
        end: 0.02,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-2',
        text: '乙',
        start: 0.04,
        end: 0.045,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-3',
        text: '丙',
        start: 0.05,
        end: 0.06,
        speech_segment_id: 'speech-1',
      },
    ]
    const editTiming = { masterDuration: 0.08, fps: 30 }
    const first = splitSceneAtWord(
      plan([scene('scene-1', 'word-1', 'word-3', '甲乙丙')]),
      timeline,
      editTiming,
      'scene-1',
      'word-2',
      () => 'scene-2',
    )
    const snapshot = structuredClone(first)

    expect(() => splitSceneAtWord(
      first,
      timeline,
      editTiming,
      'scene-2',
      'word-3',
      () => 'scene-3',
    )).toThrow()
    expect(first).toEqual(snapshot)
  })

  it('rejects timing contexts that do not contain the authoritative words', () => {
    expect(() => splitSceneAtWord(
      plan([scene('scene-1', 'word-1', 'word-3', '甲乙丙')]),
      words(['甲', '乙', '丙']),
      { masterDuration: 1, fps: 30 },
      'scene-1',
      'word-2',
      () => 'scene-2',
    )).toThrow()
  })
})

describe('mergeScene', () => {
  const timeline = words(['甲', ' 乙', '丙', '丁', '戊', '己'])
  const threeScenes = plan([
    scene('scene-1', 'word-1', 'word-2', 'AI 左一', ['甲'], 'fade-up'),
    scene('scene-2', 'word-3', 'word-4', 'AI 中间', ['丁'], 'scale'),
    scene('scene-3', 'word-5', 'word-6', 'AI 右一', ['己'], 'fade-up'),
  ])

  it('merges with previous and preserves the timeline-left survivor ID and visuals', () => {
    const original = {
      ...threeScenes,
      applied_job_id: 72,
      job_id: 7002,
      error: '旧 AI 任务失败',
    }
    const snapshot = structuredClone(original)

    const next = mergeScene(
      original,
      timeline,
      timing,
      'scene-2',
      'previous',
    )

    expect(next.scenes).toEqual([
      scene('scene-1', 'word-1', 'word-4', '甲 乙丙丁', ['甲'], 'fade-up'),
      threeScenes.scenes[2],
    ])
    expect(next.generation_revision).toBe(threeScenes.generation_revision + 1)
    expect(next).toMatchObject({ applied_job_id: null })
    expect(next).toMatchObject({ job_id: null, error: '' })
    expect(sceneWordIds(next, timeline)).toEqual(timeline.map(word => word.id))
    expect(original).toEqual(snapshot)
  })

  it('merges with next and preserves the timeline-left survivor ID and visuals', () => {
    const next = mergeScene(
      threeScenes,
      timeline,
      timing,
      'scene-2',
      'next',
    )

    expect(next.scenes).toEqual([
      threeScenes.scenes[0],
      scene('scene-2', 'word-3', 'word-6', '丙丁戊己', ['丁'], 'scale'),
    ])
    expect(next.generation_revision).toBe(threeScenes.generation_revision + 1)
    expect(sceneWordIds(next, timeline)).toEqual(timeline.map(word => word.id))
  })

  it.each([
    ['first scene with previous', 'scene-1', 'previous'],
    ['last scene with next', 'scene-3', 'next'],
    ['unknown scene', 'missing-scene', 'next'],
  ] as const)('rejects %s', (_name, sceneId, direction) => {
    expect(() => mergeScene(
      threeScenes,
      timeline,
      timing,
      sceneId,
      direction,
    )).toThrow()
  })
})

describe('moveSceneBoundary', () => {
  const timeline = words(['甲', '乙', '丙', '丁', '戊', '己'])

  it('moves forward by whole words and keeps a complete immutable partition', () => {
    const original = {
      ...twoScenePlan(),
      applied_job_id: 73,
      job_id: 7003,
      error: '旧 AI 任务失败',
    }
    const snapshot = structuredClone(original)

    const next = moveSceneBoundary(
      original,
      timeline,
      timing,
      'scene-1',
      'forward',
      1,
    )

    expect(next.scenes).toEqual([
      scene('scene-1', 'word-1', 'word-3', '甲乙丙', ['甲', '丙'], 'fade-up'),
      scene('scene-2', 'word-4', 'word-6', '丁戊己', ['己'], 'scale'),
    ])
    expect(next.generation_revision).toBe(original.generation_revision + 1)
    expect(next).toMatchObject({ applied_job_id: null })
    expect(next).toMatchObject({ job_id: null, error: '' })
    expect(sceneWordIds(next, timeline)).toEqual(timeline.map(word => word.id))
    expect(original).toEqual(snapshot)
  })

  it('moves backward by whole words and filters highlights against new exact text', () => {
    const next = moveSceneBoundary(
      plan([
        scene('scene-1', 'word-1', 'word-3', 'AI left', ['甲', '丙'], 'fade-up'),
        scene('scene-2', 'word-4', 'word-6', 'AI right', ['丁', '己'], 'scale'),
      ]),
      timeline,
      timing,
      'scene-1',
      'backward',
      1,
    )

    expect(next.scenes).toEqual([
      scene('scene-1', 'word-1', 'word-2', '甲乙', ['甲'], 'fade-up'),
      scene('scene-2', 'word-3', 'word-6', '丙丁戊己', ['丁', '己'], 'scale'),
    ])
    expect(next.generation_revision).toBe(4)
    expect(sceneWordIds(next, timeline)).toEqual(timeline.map(word => word.id))
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid word count %s',
    (wordCount) => {
      expect(() => moveSceneBoundary(
        twoScenePlan(),
        timeline,
        timing,
        'scene-1',
        'forward',
        wordCount,
      )).toThrow()
    },
  )

  it('rejects moves that would empty either adjacent scene', () => {
    const oneWordEach = plan([
      scene('scene-1', 'word-1', 'word-1', '甲'),
      scene('scene-2', 'word-2', 'word-2', '乙'),
    ])
    const twoWords = words(['甲', '乙'])

    expect(() => moveSceneBoundary(
      oneWordEach,
      twoWords,
      timing,
      'scene-1',
      'backward',
      1,
    )).toThrow()
    expect(() => moveSceneBoundary(
      oneWordEach,
      twoWords,
      timing,
      'scene-1',
      'forward',
      1,
    )).toThrow()
  })

  it('rejects boundary overflow, missing neighbors, unknown scenes, and directions', () => {
    expect(() => moveSceneBoundary(
      twoScenePlan(),
      timeline,
      timing,
      'scene-1',
      'forward',
      4,
    )).toThrow()
    expect(() => moveSceneBoundary(
      twoScenePlan(),
      timeline,
      timing,
      'scene-2',
      'forward',
      1,
    )).toThrow()
    expect(() => moveSceneBoundary(
      twoScenePlan(),
      timeline,
      timing,
      'missing-scene',
      'forward',
      1,
    )).toThrow()
    expect(() => moveSceneBoundary(
      twoScenePlan(),
      timeline,
      timing,
      'scene-1',
      'sideways' as 'forward',
      1,
    )).toThrow()
  })

  it('rejects a move that would collapse the new boundary onto zero', () => {
    const timeline = words(['甲', '乙', '丙'])
    timeline[1] = { ...timeline[1], start: 0 }
    const original = plan([
      scene('scene-1', 'word-1', 'word-2', '甲乙'),
      scene('scene-2', 'word-3', 'word-3', '丙'),
    ])
    const snapshot = structuredClone(original)

    expect(() => moveSceneBoundary(
      original,
      timeline,
      timing,
      'scene-1',
      'backward',
      1,
    )).toThrow()
    expect(original).toEqual(snapshot)
  })
})

describe('editSceneVisuals', () => {
  it('updates only the target plan scene and matching local render visuals', () => {
    const original = projectForVisualEdit()
    original.scene_plan = {
      ...original.scene_plan,
      applied_job_id: 74,
      job_id: 7004,
      error: '旧 AI 任务失败',
    } as ScenePlanDocument
    const snapshot = structuredClone(original)
    const update = {
      displayText: '新的屏显文字',
      highlight: ['新的', '文字'],
      animation: 'scale',
    }

    const next = editSceneVisuals(original, 'scene-1', update)
    update.highlight.push('以后新增的值')

    expect(next.scene_plan.scenes[0]).toEqual({
      ...original.scene_plan.scenes[0],
      displayText: '新的屏显文字',
      highlight: ['新的', '文字'],
      animation: 'scale',
    })
    expect(next.scene_plan.generation_revision)
      .toBe(original.scene_plan.generation_revision + 1)
    expect(next.scene_plan).toMatchObject({ applied_job_id: null })
    expect(next.scene_plan).toMatchObject({ job_id: null, error: '' })
    expect(next.scene_plan.scenes[1]).toEqual(original.scene_plan.scenes[1])
    expect(next.render_input.segments[0]).toEqual({
      ...original.render_input.segments[0],
      text: '新的屏显文字',
      highlight: ['新的', '文字'],
      animation: 'scale',
    })
    expect(next.render_input.segments[0].start).toBe(0)
    expect(next.render_input.segments[0].end).toBe(1)
    expect(next.render_input.segments[1]).toEqual(original.render_input.segments[1])
    expect(next.paragraphs).toBe(original.paragraphs)
    expect(next.master_audio).toBe(original.master_audio)
    expect(next.voice_settings).toBe(original.voice_settings)
    expect(next.render_input.audio).toBe('/uploads/master.wav')
    expect(original).toEqual(snapshot)
  })

  it('returns the original project for an exact visual no-op without advancing ownership', () => {
    const project = projectForVisualEdit()
    project.scene_plan = {
      ...project.scene_plan,
      applied_job_id: 75,
      job_id: 7005,
      error: '保留原状态',
    } as ScenePlanDocument
    const current = project.scene_plan.scenes[0]

    const next = editSceneVisuals(project, current.id, {
      displayText: current.displayText,
      highlight: [...current.highlight],
      animation: current.animation,
    })

    expect(next).toBe(project)
    expect(next.scene_plan.generation_revision).toBe(3)
    expect(next.scene_plan).toMatchObject({
      applied_job_id: 75,
      job_id: 7005,
      error: '保留原状态',
    })
  })

  it('rejects edits while AI generation owns the scene plan', () => {
    const project = projectForVisualEdit()
    project.scene_plan = {
      ...project.scene_plan,
      status: 'generating',
      job_id: 88,
    }
    const snapshot = structuredClone(project)

    expect(() => editSceneVisuals(project, 'scene-1', {
      displayText: '新的屏显文字',
      highlight: ['新的'],
      animation: 'scale',
    })).toThrow()
    expect(project).toEqual(snapshot)
  })

  it.each([
    {
      name: 'blank display text',
      update: { displayText: '   ', highlight: [], animation: 'fade-up' },
    },
    {
      name: 'blank animation',
      update: { displayText: '有效', highlight: [], animation: '   ' },
    },
    {
      name: 'highlight outside display text',
      update: { displayText: '有效', highlight: ['无效'], animation: 'fade-up' },
    },
    {
      name: 'blank highlight',
      update: { displayText: '有效', highlight: [''], animation: 'fade-up' },
    },
    {
      name: 'duplicate highlight',
      update: { displayText: '有效有效', highlight: ['有效', '有效'], animation: 'fade-up' },
    },
  ])('rejects $name', ({ update }) => {
    expect(() => editSceneVisuals(
      projectForVisualEdit(),
      'scene-1',
      update,
    )).toThrow()
  })

  it('rejects animations outside the exact template manifest allowlist', () => {
    const project = projectForVisualEdit()
    const snapshot = structuredClone(project)

    expect(() => editSceneVisuals(project, 'scene-1', {
      displayText: '新的屏显文字',
      highlight: ['新的'],
      animation: 'unsupported-spin',
    })).toThrow()
    expect(project).toEqual(snapshot)
  })

  it('rejects visual edits when the exact template version is unknown', () => {
    const project = projectForVisualEdit()
    project.render_input = {
      ...project.render_input,
      templateVersion: 999,
    }
    const snapshot = structuredClone(project)

    expect(() => editSceneVisuals(project, 'scene-1', {
      displayText: '新的屏显文字',
      highlight: ['新的'],
      animation: 'scale',
    })).toThrow()
    expect(project).toEqual(snapshot)
  })

  it('rejects unknown scenes and a missing or ambiguous render segment match', () => {
    const project = projectForVisualEdit()
    const update = {
      displayText: '有效',
      highlight: ['有效'],
      animation: 'fade-up',
    }

    expect(() => editSceneVisuals(project, 'missing-scene', update)).toThrow()
    expect(() => editSceneVisuals(
      {
        ...project,
        render_input: {
          ...project.render_input,
          segments: project.render_input.segments.slice(1),
        },
      },
      'scene-1',
      update,
    )).toThrow()
    expect(() => editSceneVisuals(
      {
        ...project,
        render_input: {
          ...project.render_input,
          segments: [
            ...project.render_input.segments,
            { ...project.render_input.segments[0] },
          ],
        },
      },
      'scene-1',
      update,
    )).toThrow()
  })
})

describe('applyScenePlanToProject', () => {
  it('reprojects a word-boundary edit immediately without changing audio', () => {
    const original = projectForVisualEdit()
    original.scene_plan = plan([
      scene('scene-1', 'word-1', 'word-2', '甲乙', [], 'fade-up'),
    ])
    original.render_input = {
      ...original.render_input,
      segments: [{
        id: 'scene-1',
        start: 0,
        end: 2,
        text: '甲乙',
        highlight: [],
        animation: 'fade-up',
      }],
    }
    const nextPlan = splitSceneAtWord(
      original.scene_plan,
      original.master_audio.word_timings,
      {
        masterDuration: original.master_audio.duration,
        fps: original.render_input.composition.fps,
      },
      'scene-1',
      'word-2',
      () => 'scene-split',
    )

    const next = applyScenePlanToProject(original, nextPlan)

    expect(next.render_input.segments).toEqual([
      {
        id: 'scene-1',
        start: 0,
        end: 0.4,
        text: '甲',
        highlight: [],
        animation: 'fade-up',
      },
      {
        id: 'scene-split',
        start: 0.4,
        end: 2,
        text: '乙',
        highlight: [],
        animation: 'fade-up',
      },
    ])
    expect(next.master_audio).toBe(original.master_audio)
    expect(next.paragraphs).toBe(original.paragraphs)
    expect(next.render_input.audio).toBe(original.master_audio.audio_url)
  })
})
