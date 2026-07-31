import { describe, expect, it } from 'vitest'

import type {
  GlobalWordTiming,
  ScenePlanSceneDocument,
} from '@/lib/api/text-videos'

import {
  makeMasterAudio,
  makeRenderInput,
  makeScenePlan,
  makeVideoReadyProject,
} from './test-fixtures'
import {
  applyRuleMotionPlan,
  buildRuleMotionPlan,
  displayBoundaryForWordSplit,
} from './motion-plan'

function timeline(tokens: string[]): GlobalWordTiming[] {
  return tokens.map((text, index) => ({
    id: `word-${index + 1}`,
    text,
    start: index * 0.5,
    end: (index + 1) * 0.5,
    speech_segment_id: 'speech-1',
  }))
}

function scene(
  overrides: Partial<ScenePlanSceneDocument> = {},
): ScenePlanSceneDocument {
  return {
    id: 'scene-1',
    fromWordId: 'word-1',
    throughWordId: 'word-6',
    displayText: '做AI视频的，一个月没赚到钱',
    highlight: ['没赚到钱'],
    animation: 'fade-up',
    ...overrides,
  }
}

describe('buildRuleMotionPlan', () => {
  const words = timeline(['做', 'AI', '视频', '的', '一个月', '没赚到钱'])

  it('builds the same lossless semantic chunks on every call', () => {
    const first = buildRuleMotionPlan(scene(), words)
    const second = buildRuleMotionPlan(scene(), words)

    expect(second).toEqual(first)
    expect(first.chunks.map(chunk => chunk.displayText).join(''))
      .toBe('做AI视频的，一个月没赚到钱')
    expect(first.chunks.map(chunk => [
      chunk.fromWordId,
      chunk.throughWordId,
    ])).toEqual([
      ['word-1', 'word-4'],
      ['word-5', 'word-6'],
    ])
    expect(first.chunks.at(-1)).toMatchObject({
      highlight: ['没赚到钱'],
      motionPreset: 'impact',
      emphasis: 'punch',
    })
    expect(first).toMatchObject({
      transition: 'block-wipe',
      intensity: 0.8,
    })
  })

  it('merges a short tail backward instead of creating a weak final card', () => {
    const shortTailScene = scene({
      displayText: '这是一个完整观点，结论',
      highlight: [],
    })

    const plan = buildRuleMotionPlan(shortTailScene, words)

    expect(plan.chunks.at(-1)?.displayText.endsWith('结论')).toBe(true)
    expect(plan.chunks.every(chunk => chunk.displayText.trim().length >= 4))
      .toBe(true)
  })

  it('keeps a short scene as one deterministic reveal chunk', () => {
    const shortWords = timeline(['结', '论'])
    const plan = buildRuleMotionPlan(scene({
      throughWordId: 'word-2',
      displayText: '结论',
      highlight: [],
    }), shortWords)

    expect(plan).toEqual({
      transition: 'block-wipe',
      intensity: 0.65,
      chunks: [{
        id: 'scene-1-chunk-1',
        fromWordId: 'word-1',
        throughWordId: 'word-2',
        displayText: '结论',
        highlight: [],
        motionPreset: 'reveal',
        emphasis: 'normal',
      }],
    })
  })
})

describe('displayBoundaryForWordSplit', () => {
  it('preserves visual text while proportionally moving either boundary', () => {
    const sourceWords = timeline(['今天', '制作AI', '视频'])
    const displayText = '今天做 AI，视频'

    const afterFirst = displayBoundaryForWordSplit(
      displayText,
      sourceWords,
      1,
    )
    const afterSecond = displayBoundaryForWordSplit(
      displayText,
      sourceWords,
      2,
    )

    expect([
      displayText.slice(0, afterFirst),
      displayText.slice(afterFirst),
    ]).toEqual(['今天', '做 AI，视频'])
    expect([
      displayText.slice(0, afterSecond),
      displayText.slice(afterSecond),
    ]).toEqual(['今天做 AI，', '视频'])
  })
})

describe('applyRuleMotionPlan', () => {
  it('persists motion while leaving a v1 render segment unchanged', () => {
    const words = timeline(['做', 'AI', '视频', '的', '一个月', '没赚到钱'])
    const sourceHash = 'm'.repeat(64)
    const sourceScene = scene()
    const project = makeVideoReadyProject({
      script: sourceScene.displayText,
      master_audio: makeMasterAudio({
        status: 'ready',
        timeline_status: 'ready',
        audio_url: '/api/uploads/master.mp3',
        duration: 3,
        source_hash: sourceHash,
        word_timings: words,
        timeline_source: 'provider',
      }),
      scene_plan: makeScenePlan({
        status: 'ready',
        generation_revision: 4,
        master_source_hash: sourceHash,
        scenes: [sourceScene],
      }),
      render_input: makeRenderInput({
        audio: '/api/uploads/master.mp3',
        segments: [{
          id: 'scene-1',
          start: 0,
          end: 3,
          text: sourceScene.displayText,
          highlight: [...sourceScene.highlight],
          animation: 'fade-up',
        }],
      }),
    })

    const next = applyRuleMotionPlan(project)

    expect(next.scene_plan.scenes[0].motion?.chunks).toHaveLength(2)
    expect(next.scene_plan.generation_revision).toBe(5)
    expect(next.render_input.segments[0]).toEqual(
      project.render_input.segments[0],
    )
    expect(project.scene_plan.scenes[0].motion).toBeUndefined()
  })
})
