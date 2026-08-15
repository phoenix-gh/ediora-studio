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


const previewPlayer = vi.hoisted(() => ({
  play: vi.fn(),
}))

vi.mock('./RemotionPreview', () => ({
  RemotionPreview: ({
    selectedSceneId,
    playerRef,
  }: {
    selectedSceneId: string
    playerRef?: { current: typeof previewPlayer | null }
  }) => {
    if (playerRef) playerRef.current = previewPlayer
    return <div>Remotion 预览 · {selectedSceneId || 'empty'}</div>
  },
}))

describe('VideoStage', () => {
  it('starts playback when requesting a full preview', async () => {
    const user = userEvent.setup()
    const onPreviewAll = vi.fn()
    previewPlayer.play.mockClear()

    render(
      <VideoStage
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={onPreviewAll}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '预览全片' }))

    expect(onPreviewAll).toHaveBeenCalledOnce()
    expect(previewPlayer.play).toHaveBeenCalledOnce()
  })

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

  it('keeps MP4 generation disabled until the video timeline is ready', async () => {
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
    expect(screen.getByRole('button', { name: '生成视频' })).toBeDisabled()
  })

  it('launches MP4 generation and shows durable render progress', async () => {
    const user = userEvent.setup()
    const onRenderVideo = vi.fn()
    const ready = makeVideoReadyProject({
      render_state: {
        ...makeVideoReadyProject().render_state,
        status: 'rendering',
        job_id: 301,
        progress: 42,
      },
    })

    const { rerender } = render(
      <VideoStage
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
        onRenderVideo={onRenderVideo}
      />,
    )

    await user.click(screen.getByRole('button', { name: '生成视频' }))
    expect(onRenderVideo).toHaveBeenCalledTimes(1)

    rerender(
      <VideoStage
        project={ready}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
        onRenderVideo={onRenderVideo}
        renderAction={{
          status: 'running',
          error: '',
          retryable: false,
          jobId: 301,
          stepKey: '',
          progress: 42,
        }}
      />,
    )

    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '42',
    )
    expect(screen.getByText('正在渲染 42%')).toBeVisible()
    expect(screen.getByRole('button', {
      name: '正在生成视频',
    })).toBeDisabled()
  })

  it('plays and downloads the current MP4 result', () => {
    render(
      <VideoStage
        project={makeVideoReadyProject({
          output_asset_url: '/api/uploads/result.mp4',
          output_stale: false,
          render_state: {
            ...makeVideoReadyProject().render_state,
            status: 'ready',
            progress: 100,
            asset_id: 81,
          },
        })}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
        onRenderVideo={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('成片视频')).toHaveAttribute(
      'src',
      'http://localhost:8000/api/uploads/result.mp4',
    )
    expect(screen.getByRole('link', { name: '下载 MP4' })).toHaveAttribute(
      'href',
      'http://localhost:8000/api/text-videos/1/output/download',
    )
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

  it('switches to another registered template with that template defaults', async () => {
    const user = userEvent.setup()
    const onApplyTemplate = vi.fn().mockResolvedValue(undefined)

    render(
      <VideoStage
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
        previewAll={false}
        onPreviewAll={vi.fn()}
        onProjectChange={vi.fn()}
        onOpenSceneDirection={vi.fn()}
        onApplyTemplateSettings={vi.fn()}
        onApplyTemplate={onApplyTemplate}
      />,
    )

    await user.click(screen.getByRole('combobox', { name: '视频模板' }))
    await user.click(screen.getByRole('option', { name: '动感大字' }))

    expect(onApplyTemplate).toHaveBeenCalledWith(
      'kinetic-punch-v1',
      1,
      expect.objectContaining({
        accentColor: expect.any(String),
      }),
    )
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
        onRenderVideo={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      '模板视觉已更新，当前为上一版成片；重新渲染后更新',
    )
    expect(screen.getByRole('button', {
      name: '重新生成视频',
    })).toBeEnabled()
  })
})
