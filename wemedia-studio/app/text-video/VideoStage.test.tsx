// @vitest-environment jsdom

import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { TextVideoProject } from '@/lib/api/text-videos'
import {
  makeScenePlan,
  makeVideoReadyProject,
} from '@/lib/text-video/test-fixtures'

import { VideoStage } from './VideoStage'


vi.mock('./RemotionPreview', () => ({
  RemotionPreview: ({ selectedSceneId }: { selectedSceneId: string }) => (
    <div>Remotion 预览 · {selectedSceneId || 'empty'}</div>
  ),
}))

describe('VideoStage', () => {
  it('renders persisted scenes and selects them by stable id', async () => {
    const user = userEvent.setup()
    const onSelectScene = vi.fn()

    render(
      <VideoStage
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={onSelectScene}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
      />,
    )

    expect(screen.getAllByTestId('scene-card')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '场景 02' }))
    expect(onSelectScene).toHaveBeenCalledWith('scene-2')
  })

  it('edits visual fields without changing narration or master audio bytes', async () => {
    const user = userEvent.setup()
    const original = makeVideoReadyProject()
    const onProjectChange = vi.fn()

    render(
      <VideoStage
        project={original}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={onProjectChange}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
      />,
    )

    const text = screen.getByRole('textbox', { name: '场景展示文字' })
    await user.clear(text)
    await user.type(text, '甲乙，重点')
    await user.tab()

    const next = onProjectChange.mock.calls.at(-1)?.[0] as TextVideoProject
    expect(next.scene_plan.scenes[0].displayText).toBe('甲乙，重点')
    expect(next.render_input.segments[0].text).toBe('甲乙，重点')
    expect(next.master_audio).toEqual(original.master_audio)
    expect(next.paragraphs).toEqual(original.paragraphs)
    expect(next.render_input.audio).toBe(original.render_input.audio)
  })

  it('splits and merges scenes on word boundaries while preserving audio', async () => {
    const user = userEvent.setup()
    const original = makeVideoReadyProject()

    function Harness() {
      const [project, setProject] = useState(original)
      return (
        <VideoStage
          project={project}
          selectedSceneId="scene-1"
          onSelectScene={vi.fn()}
          previewAll={false}
          onPreviewAll={vi.fn()}
          onProjectChange={setProject}
          onOpenSceneDirection={vi.fn()}
          onApplyTemplateSettings={vi.fn()}
        />
      )
    }

    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '拆分场景' }))
    expect(screen.getAllByTestId('scene-card')).toHaveLength(3)
    expect(screen.getByLabelText('主音频')).toHaveAttribute(
      'src',
      'http://localhost:8000/api/uploads/master.mp3',
    )

    await user.click(screen.getByRole('button', {
      name: '与下一场景合并',
    }))
    expect(screen.getAllByTestId('scene-card')).toHaveLength(2)
  })

  it('exposes scene generation and an explicit unavailable MP4 state', async () => {
    const user = userEvent.setup()
    const onOpenSceneDirection = vi.fn()
    const ready = makeVideoReadyProject()

    render(
      <VideoStage
        project={{
          ...ready,
          scene_plan: makeScenePlan(),
          render_input: { ...ready.render_input, audio: '' },
        }}
        selectedSceneId=""
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={onOpenSceneDirection}
        onApplyTemplateSettings={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'AI 生成分镜' }))
    expect(onOpenSceneDirection).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', {
      name: 'MP4 渲染暂未开放',
    })).toBeDisabled()
  })

  it('opens work-level template settings separately from the AI director', async () => {
    const user = userEvent.setup()
    const onOpenSceneDirection = vi.fn()

    render(
      <VideoStage
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={onOpenSceneDirection}
        onApplyTemplateSettings={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', {
      name: '模板视觉设置',
    }))

    expect(screen.getByRole('dialog', {
      name: '模板视觉设置',
    })).toBeVisible()
    expect(onOpenSceneDirection).not.toHaveBeenCalled()
  })

  it('labels an existing output as the previous render after visuals change', () => {
    render(
      <VideoStage
        project={makeVideoReadyProject({
          output_asset_url: '/api/uploads/previous.mp4',
          output_stale: true,
        })}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      '模板视觉已更新，当前为上一版成片；重新渲染后更新',
    )
    expect(screen.getByRole('button', {
      name: 'MP4 渲染暂未开放',
    })).toBeDisabled()
  })
})
