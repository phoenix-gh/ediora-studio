// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { makeSpeechSegment, makeTextVideoProject } from '@/lib/text-video/test-fixtures'

import { SpeechSplitPreviewDialog } from './SpeechSplitPreviewDialog'


const proposal = {
  segments: [
    { id: 'segment-1', text: '甲。', estimated_duration: 0.5, reason: '完整句' },
    { id: 'segment-2', text: '乙。', estimated_duration: 0.5, reason: '完整句' },
  ],
  speech_split_mode: 'auto' as const,
}


describe('SpeechSplitPreviewDialog', () => {
  it('leaves the project unchanged until explicit application', async () => {
    const user = userEvent.setup()
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [makeSpeechSegment('segment-1', '甲。乙。')],
    })
    const onApply = vi.fn()
    const onOpenChange = vi.fn()
    const createPreview = vi.fn().mockResolvedValue({
      jobs: [{ id: 8, flow: 'text_video_split_preview', target_id: project.id }],
      project,
    })
    const getJob = vi.fn().mockResolvedValue({
      id: 8,
      status: 'succeeded',
      steps: [{ key: 'propose_boundaries', status: 'succeeded', output: proposal }],
    })

    render(
      <SpeechSplitPreviewDialog
        open
        project={project}
        direction="适合短句口播"
        createPreview={createPreview}
        getJob={getJob}
        onOpenChange={onOpenChange}
        onApply={onApply}
      />,
    )

    expect(onApply).not.toHaveBeenCalled()
    expect(await screen.findByText('甲。')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onApply).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('applies the exact validated slices only after clicking 应用分段', async () => {
    const user = userEvent.setup()
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [makeSpeechSegment('segment-1', '甲。乙。')],
    })
    const onApply = vi.fn()

    render(
      <SpeechSplitPreviewDialog
        open
        project={project}
        direction=""
        createPreview={vi.fn().mockResolvedValue({
          jobs: [{ id: 8, flow: 'text_video_split_preview', target_id: project.id }],
          project,
        })}
        getJob={vi.fn().mockResolvedValue({
          id: 8,
          status: 'succeeded',
          steps: [{ key: 'propose_boundaries', status: 'succeeded', output: proposal }],
        })}
        onOpenChange={vi.fn()}
        onApply={onApply}
      />,
    )

    expect(await screen.findByRole('button', { name: '应用分段' })).toBeEnabled()
    expect(proposal.segments.map(item => item.text).join('')).toBe(project.script)
    expect(onApply).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '应用分段' }))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      paragraphs: expect.arrayContaining([
        expect.objectContaining({ id: 'segment-1', text: '甲。' }),
        expect.objectContaining({ id: 'segment-2', text: '乙。' }),
      ]),
      speech_split_mode: 'auto',
    }))
  })

  it('shows the exact latest failed step error', async () => {
    const project = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [makeSpeechSegment('segment-1', '甲。乙。')],
    })

    render(
      <SpeechSplitPreviewDialog
        open
        project={project}
        direction=""
        createPreview={vi.fn().mockResolvedValue({
          jobs: [{ id: 8, flow: 'text_video_split_preview', target_id: project.id }],
          project,
        })}
        getJob={vi.fn().mockResolvedValue({
          id: 8,
          status: 'failed',
          steps: [{
            id: 2,
            key: 'propose_boundaries',
            attempt: 2,
            status: 'failed',
            output: {},
            error: '模型返回了无效边界',
            retryable: false,
          }],
        })}
        onOpenChange={vi.fn()}
        onApply={vi.fn()}
      />,
    )

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('模型返回了无效边界')
  })
})
