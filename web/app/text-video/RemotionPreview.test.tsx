// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeScenePlan, makeVideoReadyProject } from '@/lib/text-video/test-fixtures'
import { resolveTextVideoTemplate } from '@/remotion/registry'

import { RemotionPreview } from './RemotionPreview'


const playerSpy = vi.hoisted(() => vi.fn((props: {
  component: unknown
  inputProps: {
    audio: string
    segments: unknown[]
  }
  inFrame: number
  outFrame: number
}) => {
  void props
  return <div data-testid="mock-remotion-player" />
}))

vi.mock('@remotion/player', () => ({
  Player: playerSpy,
}))

describe('RemotionPreview', () => {
  beforeEach(() => {
    playerSpy.mockClear()
  })

  it('uses the registered template and resolved master audio URL', () => {
    const project = makeVideoReadyProject()

    render(
      <RemotionPreview
        project={project}
        selectedSceneId="scene-2"
        previewAll={false}
      />,
    )

    expect(screen.getByTestId('remotion-preview')).toBeVisible()
    const props = playerSpy.mock.calls[0][0]
    expect(props.component).toBe(resolveTextVideoTemplate(
      'tech-text-v1',
      1,
    ).component)
    expect(props.inputProps.audio).toBe(
      'http://localhost:8000/api/uploads/master.mp3',
    )
    expect(props.inputProps.segments).toEqual(project.render_input.segments)
    expect(props.inFrame).toBe(60)
    expect(props.outFrame).toBe(119)
  })

  it('shows an explicit empty state before scene generation', () => {
    const project = makeVideoReadyProject({
      scene_plan: makeScenePlan(),
    })

    render(
      <RemotionPreview
        project={project}
        selectedSceneId=""
        previewAll
      />,
    )

    expect(screen.getByText('分镜尚未生成')).toBeVisible()
    expect(playerSpy).not.toHaveBeenCalled()
  })

  it('shows a validation error instead of fixture playback', () => {
    const ready = makeVideoReadyProject()
    const project = {
      ...ready,
      render_input: {
        ...ready.render_input,
        segments: ready.render_input.segments.map((scene, index) => (
          index === 1 ? { ...scene, start: 2.5 } : scene
        )),
      },
    }

    render(
      <RemotionPreview
        project={project}
        selectedSceneId="scene-1"
        previewAll
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('预览数据无效')
    expect(playerSpy).not.toHaveBeenCalled()
  })
})
