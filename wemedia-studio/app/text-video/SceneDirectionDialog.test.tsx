// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SceneDirectionDialog } from './SceneDirectionDialog'


describe('SceneDirectionDialog', () => {
  it('cancels and closes with Escape without launching a scene job', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn()
    const onOpenChange = vi.fn()

    const { rerender } = render(
      <SceneDirectionDialog
        open
        initialScope="selected"
        selectedSceneId="scene-stable-2"
        onOpenChange={onOpenChange}
        onGenerate={onGenerate}
      />,
    )

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(onGenerate).not.toHaveBeenCalled()

    onOpenChange.mockClear()
    rerender(
      <SceneDirectionDialog
        open
        initialScope="selected"
        selectedSceneId="scene-stable-2"
        onOpenChange={onOpenChange}
        onGenerate={onGenerate}
      />,
    )
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('submits selected scope with the stable scene id and direction', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()

    render(
      <SceneDirectionDialog
        open
        initialScope="selected"
        selectedSceneId="scene-stable-2"
        onOpenChange={onOpenChange}
        onGenerate={onGenerate}
      />,
    )

    await user.click(screen.getByRole('radio', {
      name: /仅调整当前场景/,
    }))
    await user.type(
      screen.getByRole('textbox', { name: '创意方向' }),
      '强调转折，节奏更有力量',
    )
    await user.click(screen.getByRole('button', { name: '让 AI 调整画面' }))

    expect(onGenerate).toHaveBeenCalledWith({
      scope: 'selected',
      selected_scene_id: 'scene-stable-2',
      direction: '强调转折，节奏更有力量',
    })
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('uses all scope when there is no existing selected scene', async () => {
    const user = userEvent.setup()
    const onGenerate = vi.fn().mockResolvedValue(undefined)

    render(
      <SceneDirectionDialog
        open
        initialScope="all"
        selectedSceneId=""
        onOpenChange={vi.fn()}
        onGenerate={onGenerate}
      />,
    )

    expect(screen.getByRole('radio', {
      name: /调整全部场景/,
    })).toBeChecked()
    expect(screen.getByRole('radio', {
      name: /仅调整当前场景/,
    })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: '让 AI 调整画面' }))
    expect(onGenerate).toHaveBeenCalledWith({
      scope: 'all',
      selected_scene_id: '',
      direction: '',
    })
  })

  it('stays open and shows a real launch error, closing only after success', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onGenerate = vi.fn()
      .mockRejectedValueOnce(new Error('模型返回了无效分镜'))
      .mockResolvedValueOnce(undefined)

    render(
      <SceneDirectionDialog
        open
        initialScope="selected"
        selectedSceneId="scene-1"
        onOpenChange={onOpenChange}
        onGenerate={onGenerate}
      />,
    )

    await user.click(screen.getByRole('button', { name: '让 AI 调整画面' }))
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('模型返回了无效分镜')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    await user.click(screen.getByRole('button', { name: '让 AI 调整画面' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps full regeneration scoped to all despite an existing selection', () => {
    render(
      <SceneDirectionDialog
        open
        initialScope="all"
        selectedSceneId="scene-stable-2"
        onOpenChange={vi.fn()}
        onGenerate={vi.fn()}
      />,
    )

    expect(screen.getByRole('radio', {
      name: /调整全部场景/,
    })).toBeChecked()
  })
})
