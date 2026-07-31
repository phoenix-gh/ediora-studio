// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { makeVideoReadyProject } from '@/lib/text-video/test-fixtures'
import { applyRuleMotionPlan } from '@/lib/text-video/motion-plan'
import { applyScenePlanToProject } from '@/lib/text-video/scene-plan'

import { MotionPlanEditor } from './MotionPlanEditor'

function v2Project() {
  const original = makeVideoReadyProject()
  const scenePlan = {
    ...original.scene_plan,
    scenes: original.scene_plan.scenes.map(scene => ({
      ...scene,
      animation: 'reveal',
    })),
  }
  const selected = {
    ...original,
    render_input: {
      ...original.render_input,
      templateId: 'kinetic-punch-v2',
      templateVersion: 1,
      templateProps: {
        brandTitle: 'EDIORA',
        showBrand: true,
        accentColor: '#D8FF3E',
        showProgress: true,
        palette: 'night',
      },
    },
  }
  return applyRuleMotionPlan(
    applyScenePlanToProject(selected, scenePlan),
  )
}

describe('MotionPlanEditor', () => {
  it('shows inline V2 controls and regenerates the selected rule plan', async () => {
    const user = userEvent.setup()
    const project = v2Project()
    const onProjectChange = vi.fn()

    render(
      <MotionPlanEditor
        project={project}
        scene={project.scene_plan.scenes[0]}
        busy={false}
        onProjectChange={onProjectChange}
        onOptimize={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'AI 优化全片' }))
      .toBeEnabled()
    expect(screen.getByRole('button', { name: '自动拆句' })).toBeEnabled()
    expect(screen.getAllByLabelText('短句动作').length).toBeGreaterThan(0)
    expect(screen.getByText('精确词时间')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '自动拆句' }))
    expect(onProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({
        scene_plan: expect.objectContaining({
          scenes: expect.arrayContaining([
            expect.objectContaining({ motion: expect.any(Object) }),
          ]),
        }),
      }),
    )
  })

  it('uses a dialog for optional AI direction and keeps ready-plan errors visible', async () => {
    const user = userEvent.setup()
    const onOptimize = vi.fn().mockResolvedValue(undefined)
    const project = v2Project()
    project.scene_plan = {
      ...project.scene_plan,
      error: '上次优化失败，已保留现有动效',
    }

    render(
      <MotionPlanEditor
        project={project}
        scene={project.scene_plan.scenes[0]}
        busy={false}
        onProjectChange={vi.fn()}
        onOptimize={onOptimize}
      />,
    )

    expect(screen.getByText('上次优化失败，已保留现有动效'))
      .toBeVisible()
    await user.click(screen.getByRole('button', { name: 'AI 优化本场' }))
    expect(screen.getByRole('dialog', { name: 'AI 动效优化' })).toBeVisible()
    await user.type(screen.getByLabelText('创意方向'), '强调反差')
    await user.click(screen.getByRole('button', { name: '开始优化' }))

    expect(onOptimize).toHaveBeenCalledWith('selected', '强调反差')
  })

  it('labels non-provider timing as estimated and disables controls while busy', () => {
    const project = v2Project()
    project.master_audio = {
      ...project.master_audio,
      timeline_source: 'forced-alignment',
    }

    render(
      <MotionPlanEditor
        project={project}
        scene={project.scene_plan.scenes[0]}
        busy
        onProjectChange={vi.fn()}
        onOptimize={vi.fn()}
      />,
    )

    expect(screen.getByText('使用估算时间')).toBeVisible()
    expect(screen.getByRole('button', { name: '自动拆句' })).toBeDisabled()
    expect(screen.getByText('正在优化动效…')).toBeVisible()
  })

  it('disables a boundary move before either adjacent chunk becomes empty', () => {
    const project = v2Project()
    project.scene_plan.scenes[0] = {
      ...project.scene_plan.scenes[0],
      motion: {
        transition: 'block-wipe',
        intensity: 0.8,
        chunks: [
          {
            id: 'scene-1-chunk-1',
            fromWordId: 'word-1',
            throughWordId: 'word-1',
            displayText: '甲',
            highlight: ['甲'],
            motionPreset: 'impact',
            emphasis: 'punch',
          },
          {
            id: 'scene-1-chunk-2',
            fromWordId: 'word-2',
            throughWordId: 'word-2',
            displayText: '乙',
            highlight: [],
            motionPreset: 'reveal',
            emphasis: 'normal',
          },
        ],
      },
    }

    render(
      <MotionPlanEditor
        project={project}
        scene={project.scene_plan.scenes[0]}
        busy={false}
        onProjectChange={vi.fn()}
        onOptimize={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '边界 1 向前一词' }))
      .toBeDisabled()
    expect(screen.getByRole('button', { name: '边界 1 向后一词' }))
      .toBeDisabled()
  })

  it('moves an estimated boundary without corrupting visual whitespace', async () => {
    const user = userEvent.setup()
    const original = v2Project()
    const sourceHash = original.master_audio.source_hash
    const words = [
      {
        id: 'word-a',
        text: '今天',
        start: 0,
        end: 0.6,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-b',
        text: '制作AI',
        start: 0.6,
        end: 1.2,
        speech_segment_id: 'speech-1',
      },
      {
        id: 'word-c',
        text: '视频',
        start: 1.2,
        end: 2,
        speech_segment_id: 'speech-1',
      },
    ]
    const scene = {
      id: 'scene-estimated',
      fromWordId: 'word-a',
      throughWordId: 'word-c',
      displayText: '今天做 AI，视频',
      highlight: ['做 AI'],
      animation: 'impact',
      motion: {
        transition: 'block-wipe' as const,
        intensity: 0.8,
        chunks: [
          {
            id: 'chunk-left',
            fromWordId: 'word-a',
            throughWordId: 'word-b',
            displayText: '今天做 AI，',
            highlight: ['做 AI'],
            motionPreset: 'impact' as const,
            emphasis: 'punch' as const,
          },
          {
            id: 'chunk-right',
            fromWordId: 'word-c',
            throughWordId: 'word-c',
            displayText: '视频',
            highlight: [],
            motionPreset: 'reveal' as const,
            emphasis: 'normal' as const,
          },
        ],
      },
    }
    const project = applyScenePlanToProject({
      ...original,
      master_audio: {
        ...original.master_audio,
        duration: 2,
        source_hash: sourceHash,
        word_timings: words,
        timeline_source: 'forced-alignment',
      },
      scene_plan: {
        ...original.scene_plan,
        master_source_hash: sourceHash,
        scenes: [scene],
      },
    }, {
      ...original.scene_plan,
      master_source_hash: sourceHash,
      scenes: [scene],
    })
    const onProjectChange = vi.fn()

    render(
      <MotionPlanEditor
        project={project}
        scene={project.scene_plan.scenes[0]}
        busy={false}
        onProjectChange={onProjectChange}
        onOptimize={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', {
      name: '边界 1 向后一词',
    }))

    const changed = onProjectChange.mock.calls[0][0]
    expect(changed.scene_plan.scenes[0].motion?.chunks).toEqual([
      expect.objectContaining({
        throughWordId: 'word-a',
        displayText: '今天',
      }),
      expect.objectContaining({
        fromWordId: 'word-b',
        displayText: '做 AI，视频',
      }),
    ])
  })
})
