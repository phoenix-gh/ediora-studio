// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TEXT_VIDEO_INCOMPLETE_FIXTURE } from '@/lib/text-video/fixture'

import { TextVideoWorkbench } from './TextVideoWorkbench'

vi.mock('./RemotionPreview', () => ({
  RemotionPreview: () => <div>Remotion 预览</div>,
}))

describe('TextVideoWorkbench', () => {
  it('shows the three-stage text video workflow', () => {
    render(<TextVideoWorkbench />)

    expect(screen.getByRole('tab', { name: '稿件与分镜' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '配音制作' })).toBeVisible()
    expect(screen.getByRole('tab', { name: '视频合成' })).toBeVisible()
    expect(screen.getByText('演示项目 · 所有音频段已确认')).toBeVisible()
  })

  it('keeps video composition locked until every speech paragraph is confirmed', async () => {
    const user = userEvent.setup()
    render(<TextVideoWorkbench initialProject={TEXT_VIDEO_INCOMPLETE_FIXTURE} />)

    const videoTab = screen.getByRole('tab', { name: '视频合成' })
    expect(videoTab).toBeDisabled()
    expect(screen.getByText('还需确认 2 段配音')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '配音制作' }))
    expect(screen.getByText('6 / 8 段已确认')).toBeVisible()
  })

  it('opens the confirmed project in video composition', async () => {
    const user = userEvent.setup()
    render(<TextVideoWorkbench />)

    await user.click(screen.getByRole('tab', { name: '视频合成' }))
    expect(screen.getByText('Remotion 预览')).toBeVisible()
    expect(screen.getByRole('button', { name: '预览全片' })).toBeVisible()
  })

  it('restores the approved editor structure with controls and timeline', async () => {
    const user = userEvent.setup()
    render(<TextVideoWorkbench />)

    expect(screen.getByTestId('editor-topbar')).toBeVisible()
    expect(screen.getByTestId('editor-workspace')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '视频合成' }))

    expect(screen.getByTestId('player-controls')).toBeVisible()
    expect(screen.getByTestId('scene-timeline')).toBeVisible()
    expect(screen.getByText('配音音频')).toBeVisible()
  })
})
