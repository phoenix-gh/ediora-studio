// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { TextVideoProject } from '@/lib/api/text-videos'
import { makeSpeechSegment, makeTextVideoProject } from '@/lib/text-video/test-fixtures'

import { ScriptStage } from './ScriptStage'

vi.mock('./SpeechSplitPreviewDialog', () => ({
  SpeechSplitPreviewDialog: ({
    open,
    project,
  }: {
    open: boolean
    project: TextVideoProject
  }) => open ? (
    <div role="dialog">预览修订 {project.revision}</div>
  ) : null,
}))

describe('ScriptStage', () => {
  it('uses the exact textarea selection for a stable-ID split callback', async () => {
    const user = userEvent.setup()
    const onSplitSpeechSegment = vi.fn()
    const script = '第一句。\n  第二句。'
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script,
          paragraphs: [makeSpeechSegment('segment-1', script)],
        })}
        selectedSpeechSegmentId="segment-1"
        onSelectSpeechSegment={vi.fn()}
        onSpeechSegmentTextChange={vi.fn()}
        onSplitSpeechSegment={onSplitSpeechSegment}
        onMergeSpeechSegment={vi.fn()}
        onCollapseToSingleSegment={vi.fn()}
        onReorderSpeechSegment={vi.fn()}
      />,
    )

    const textarea = screen.getByRole(
      'textbox',
      { name: '口播内容' },
    ) as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(5, 5)
    await user.click(screen.getByRole('button', { name: '从此处分段' }))

    expect(onSplitSpeechSegment).toHaveBeenCalledWith('segment-1', 5)
  })

  it('selects segments by stable ID and shows truthful generated or estimated duration', async () => {
    const user = userEvent.setup()
    const onSelectSpeechSegment = vi.fn()
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script: '甲。乙。',
          speech_split_mode: 'manual',
          paragraphs: [
            makeSpeechSegment('a', '甲。', { status: 'confirmed', duration: 1.4 }),
            makeSpeechSegment('b', '乙。'),
          ],
        })}
        selectedSpeechSegmentId="a"
        onSelectSpeechSegment={onSelectSpeechSegment}
        onSpeechSegmentTextChange={vi.fn()}
        onSplitSpeechSegment={vi.fn()}
        onMergeSpeechSegment={vi.fn()}
        onCollapseToSingleSegment={vi.fn()}
        onReorderSpeechSegment={vi.fn()}
      />,
    )

    expect(screen.getByText('1.4 秒')).toBeVisible()
    expect(screen.getByText(/约 0.5 秒/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /段落 02/ }))
    expect(onSelectSpeechSegment).toHaveBeenCalledWith('b')
  })

  it('confirms collapse and reorder operations with the shared alert dialog', async () => {
    const user = userEvent.setup()
    const onCollapseToSingleSegment = vi.fn()
    const onReorderSpeechSegment = vi.fn()
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script: '甲。乙。',
          speech_split_mode: 'manual',
          paragraphs: [
            makeSpeechSegment('a', '甲。'),
            makeSpeechSegment('b', '乙。'),
          ],
        })}
        selectedSpeechSegmentId="b"
        onSelectSpeechSegment={vi.fn()}
        onSpeechSegmentTextChange={vi.fn()}
        onSplitSpeechSegment={vi.fn()}
        onMergeSpeechSegment={vi.fn()}
        onCollapseToSingleSegment={onCollapseToSingleSegment}
        onReorderSpeechSegment={onReorderSpeechSegment}
      />,
    )

    await user.click(screen.getByRole('button', { name: '保持整篇' }))
    expect(screen.getByRole('alertdialog')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '确认保持整篇' }))
    expect(onCollapseToSingleSegment).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: '上移' }))
    expect(screen.getByRole('alertdialog')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '确认调整顺序' }))
    expect(onReorderSpeechSegment).toHaveBeenCalledWith('b', 0)
  })

  it('exposes AI split as a deliberate action without starting it automatically', async () => {
    const user = userEvent.setup()
    const onRequestAiSplit = vi.fn()
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script: '甲。',
          paragraphs: [makeSpeechSegment('segment-1', '甲。')],
        })}
        selectedSpeechSegmentId="segment-1"
        onSelectSpeechSegment={vi.fn()}
        onSpeechSegmentTextChange={vi.fn()}
        onSplitSpeechSegment={vi.fn()}
        onMergeSpeechSegment={vi.fn()}
        onCollapseToSingleSegment={vi.fn()}
        onReorderSpeechSegment={vi.fn()}
        onRequestAiSplit={onRequestAiSplit}
      />,
    )

    expect(onRequestAiSplit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'AI 自动分段' }))
    expect(onRequestAiSplit).toHaveBeenCalledOnce()
  })

  it('flushes edits and freezes the saved project before opening AI split preview', async () => {
    const user = userEvent.setup()
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [makeSpeechSegment('segment-1', '甲。乙。')],
    })
    let resolveSaved!: (savedProject: TextVideoProject) => void
    const onPrepareSpeechSplit = vi.fn().mockReturnValue(
      new Promise<typeof project>(resolve => {
        resolveSaved = resolve
      }),
    )
    render(
      <ScriptStage
        project={project}
        selectedSpeechSegmentId="segment-1"
        onApplySpeechSplit={vi.fn()}
        onPrepareSpeechSplit={onPrepareSpeechSplit}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'AI 自动分段' }))
    expect(onPrepareSpeechSplit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '正在保存稿件…' }))
      .toBeDisabled()

    resolveSaved({ ...project, revision: 3 })

    expect(await screen.findByRole('dialog')).toHaveTextContent('预览修订 3')
  })

  it('enables a valid script and prevents duplicate continuation clicks', async () => {
    const user = userEvent.setup()
    let resolveContinue!: () => void
    const onContinueToAudio = vi.fn().mockReturnValue(
      new Promise<void>(resolve => {
        resolveContinue = resolve
      }),
    )
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script: '段落一',
          paragraphs: [makeSpeechSegment('one', '段落一')],
        })}
        selectedSpeechSegmentId="one"
        onContinueToAudio={onContinueToAudio}
      />,
    )

    const button = screen.getByRole('button', { name: '进入配音设置' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(onContinueToAudio).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()

    resolveContinue()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入配音设置' }))
        .toBeEnabled()
    })
  })

  it('keeps the script stage actionable after a failed save', async () => {
    const user = userEvent.setup()
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script: '段落一',
          paragraphs: [makeSpeechSegment('one', '段落一')],
        })}
        selectedSpeechSegmentId="one"
        onContinueToAudio={vi.fn().mockRejectedValue(
          new Error('保存稿件失败'),
        )}
      />,
    )

    await user.click(screen.getByRole('button', { name: '进入配音设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存稿件失败')
    expect(screen.getByRole('button', { name: '进入配音设置' })).toBeEnabled()
  })

  it('does not continue when every speech segment is blank', () => {
    render(
      <ScriptStage
        project={makeTextVideoProject({
          script: '   ',
          paragraphs: [makeSpeechSegment('one', '   ')],
        })}
        selectedSpeechSegmentId="one"
        onContinueToAudio={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '进入配音设置' }))
      .toBeDisabled()
  })
})
