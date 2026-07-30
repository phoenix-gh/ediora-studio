// @vitest-environment jsdom

import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { TextVideoProject } from '@/lib/api/text-videos'
import {
  makeScenePlan,
  makeSpeechSegment,
  makeTextVideoProject,
  makeVideoReadyProject,
} from '@/lib/text-video/test-fixtures'

import {
  TextVideoWorkbench,
  type TextVideoWorkbenchProps,
} from './TextVideoWorkbench'


vi.mock('./RemotionPreview', () => ({
  RemotionPreview: ({
    selectedSceneId,
  }: {
    selectedSceneId: string
  }) => <div>Remotion 预览 · {selectedSceneId || 'empty'}</div>,
}))

function renderWorkbench(
  initial: TextVideoProject,
  props: Partial<Omit<
    TextVideoWorkbenchProps,
    'projectDocument' | 'onProjectChange'
  >> = {},
) {
  function Harness() {
    const [project, setProject] = useState(initial)
    return (
      <TextVideoWorkbench
        projectDocument={project}
        onProjectChange={setProject}
        {...props}
      />
    )
  }
  return render(<Harness />)
}

describe('TextVideoWorkbench', () => {
  it('shows the three-stage text video workflow for a real project', () => {
    renderWorkbench(makeTextVideoProject())

    expect(screen.getByRole('tab', { name: '稿件与分镜' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '配音制作' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '视频合成' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '作品标题' }))
      .toHaveValue('测试文字视频')
    expect(screen.getByTestId('text-video-save-status')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    expect(screen.queryByText('演示')).not.toBeInTheDocument()
  })

  it('keeps video composition locked until speech and master audio are ready', async () => {
    const user = userEvent.setup()
    renderWorkbench(makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。', { status: 'confirmed' }),
        makeSpeechSegment('b', '乙。'),
      ],
    }))

    const videoTab = screen.getByRole('tab', { name: '视频合成' })
    expect(videoTab).toBeDisabled()
    expect(screen.getByText('还需确认 1 段配音')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '配音制作' }))
    expect(screen.getByText('1 / 2 段已确认')).toBeVisible()
  })

  it('enters video composition before scenes exist and offers generation', async () => {
    const user = userEvent.setup()
    const ready = makeVideoReadyProject()
    renderWorkbench({
      ...ready,
      stage: 'script',
      scene_plan: makeScenePlan(),
      render_input: { ...ready.render_input, audio: '' },
    })

    const videoTab = screen.getByRole('tab', { name: '视频合成' })
    expect(videoTab).toBeEnabled()
    await user.click(videoTab)
    expect(screen.getByText('Remotion 预览 · empty')).toBeVisible()
    expect(screen.getByRole('button', { name: 'AI 生成分镜' }))
      .toBeVisible()
  })

  it('keeps the approved 28/52/20 structure and truthful timeline', async () => {
    const user = userEvent.setup()
    renderWorkbench({
      ...makeVideoReadyProject(),
      stage: 'script',
    })

    expect(screen.getByTestId('editor-topbar')).toBeVisible()
    expect(screen.getByTestId('editor-shell'))
      .toHaveClass('min-w-[1120px]')

    await user.click(screen.getByRole('tab', { name: '视频合成' }))
    expect(screen.getByTestId('editor-workspace'))
      .toHaveClass('grid-cols-[28fr_52fr_20fr]')
    expect(screen.getByTestId('scene-timeline')).toBeVisible()
    expect(screen.getByText('主音频 · 4.0 秒')).toBeVisible()
    expect(screen.queryByTestId('player-controls')).not.toBeInTheDocument()
  })

  it('keeps exact narration text and stable selection through split and merge', async () => {
    const user = userEvent.setup()
    const script = '第一句。\n  第二句。'
    renderWorkbench(makeTextVideoProject({
      script,
      paragraphs: [makeSpeechSegment('segment-1', script)],
    }))

    const textarea = screen.getByRole(
      'textbox',
      { name: '口播内容' },
    ) as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(5, 5)
    await user.click(screen.getByRole('button', { name: '从此处分段' }))

    expect(screen.getByRole('textbox', { name: '口播内容' }))
      .toHaveValue('  第二句。')
    expect(screen.getAllByText('2 段')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '与上一段合并' }))
    expect(screen.getByRole('textbox', { name: '口播内容' }))
      .toHaveValue(script)
    expect(screen.getAllByText('1 段')).toHaveLength(2)
  })

  it('falls back to the first stable scene id when the selection disappears', async () => {
    const user = userEvent.setup()
    renderWorkbench(makeVideoReadyProject())

    await user.click(screen.getByRole('button', { name: '场景 02' }))
    expect(screen.getByText('Remotion 预览 · scene-2')).toBeVisible()
    await user.click(screen.getByRole('button', {
      name: '与上一场景合并',
    }))

    expect(screen.getByText('Remotion 预览 · scene-1')).toBeVisible()
    expect(screen.getByRole('textbox', { name: '场景展示文字' }))
      .toHaveValue('甲乙丙丁')
  })

  it('opens full regeneration as all and current-scene direction as selected', async () => {
    const user = userEvent.setup()
    const generate = vi.fn().mockResolvedValue(undefined)
    const ready = makeVideoReadyProject()
    const { unmount } = renderWorkbench({
      ...ready,
      scene_plan: {
        ...ready.scene_plan,
        status: 'stale',
      },
    }, {
      onGenerateScenePlan: generate,
    })

    await user.click(screen.getByRole('button', {
      name: '重新校准分镜',
    }))
    expect(screen.getByRole('radio', {
      name: /调整全部场景/,
    })).toBeChecked()
    await user.click(screen.getByRole('button', { name: '取消' }))
    unmount()

    renderWorkbench(ready, { onGenerateScenePlan: generate })
    await user.click(screen.getByRole('button', {
      name: '让 AI 调整画面',
    }))
    expect(screen.getByRole('radio', {
      name: /仅调整当前场景/,
    })).toBeChecked()
  })
})
