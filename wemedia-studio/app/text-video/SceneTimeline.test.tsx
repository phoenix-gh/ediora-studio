// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { makeVideoReadyProject } from '@/lib/text-video/test-fixtures'

import { SceneTimeline } from './SceneTimeline'


describe('SceneTimeline', () => {
  it('positions persisted scene intervals in proportion to master duration', () => {
    render(
      <SceneTimeline
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={vi.fn()}
      />,
    )

    const intervals = screen.getAllByTestId('timeline-scene')
    expect(intervals).toHaveLength(2)
    expect(intervals[0]).toHaveStyle({ left: '0%', width: '50%' })
    expect(intervals[1]).toHaveStyle({ left: '50%', width: '50%' })
    expect(screen.getByText('主音频 · 4.0 秒')).toBeVisible()
  })

  it('renders the real master audio asset and selects by stable scene id', async () => {
    const user = userEvent.setup()
    const onSelectScene = vi.fn()

    render(
      <SceneTimeline
        project={makeVideoReadyProject()}
        selectedSceneId="scene-1"
        onSelectScene={onSelectScene}
      />,
    )

    expect(screen.getByLabelText('主音频')).toHaveAttribute(
      'src',
      'http://localhost:8000/api/uploads/master.mp3',
    )
    await user.click(screen.getByRole('button', { name: '时间轴场景 02' }))
    expect(onSelectScene).toHaveBeenCalledWith('scene-2')
  })
})
