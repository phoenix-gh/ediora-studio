// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeVideoReadyProject } from '@/lib/text-video/test-fixtures'

import { TextVideoEditorClient } from './TextVideoEditorClient'


const mocks = vi.hoisted(() => ({
  generateScene: vi.fn(),
  runProjectAction: vi.fn(),
  autosave: {
    saveState: 'saved' as const,
    conflictRevision: null,
    markDirty: vi.fn(),
    flush: vi.fn(),
    retry: vi.fn(),
    acceptConflictRevision: vi.fn(),
    isDirty: vi.fn(() => false),
    getDirtyVersion: vi.fn(() => 0),
  },
}))

vi.mock('@/lib/api/text-videos', async importOriginal => {
  const actual = await importOriginal<
    typeof import('@/lib/api/text-videos')
  >()
  return {
    ...actual,
    generateTextVideoScenePlan: mocks.generateScene,
  }
})

vi.mock('./useTextVideoAutosave', () => ({
  useTextVideoAutosave: () => mocks.autosave,
}))

vi.mock('./useTextVideoProjectActions', () => ({
  useTextVideoProjectActions: () => ({
    actionStates: {},
    runProjectAction: mocks.runProjectAction,
    retryProjectJob: vi.fn(),
  }),
}))

vi.mock('./TextVideoWorkbench', () => ({
  TextVideoWorkbench: ({
    onGenerateScenePlan,
  }: {
    onGenerateScenePlan(input: {
      scope: 'all' | 'selected'
      selected_scene_id: string
      direction: string
    }): Promise<void>
  }) => (
    <button
      type="button"
      onClick={() => void onGenerateScenePlan({
        scope: 'selected',
        selected_scene_id: 'scene-stable-2',
        direction: '强调转折',
      })}
    >
      测试生成分镜
    </button>
  ),
}))

describe('TextVideoEditorClient scene action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const project = makeVideoReadyProject()
    mocks.generateScene.mockResolvedValue({ jobs: [], project })
    mocks.runProjectAction.mockImplementation(
      async (_key: string, launch: (saved: typeof project) => Promise<unknown>) => {
        await launch(project)
      },
    )
  })

  it('launches the durable selected-scene action with saved revision', async () => {
    const user = userEvent.setup()
    const project = makeVideoReadyProject()
    render(<TextVideoEditorClient initialProject={project} />)

    await user.click(screen.getByRole('button', {
      name: '测试生成分镜',
    }))

    await waitFor(() => {
      expect(mocks.runProjectAction).toHaveBeenCalledWith(
        'scene:scene-stable-2',
        expect.any(Function),
      )
    })
    expect(mocks.generateScene).toHaveBeenCalledWith(project.id, {
      revision: project.revision,
      scope: 'selected',
      selected_scene_id: 'scene-stable-2',
      direction: '强调转折',
    })
  })
})
