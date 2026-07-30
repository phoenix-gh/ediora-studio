// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeVideoReadyProject } from '@/lib/text-video/test-fixtures'

import { TextVideoEditorClient } from './TextVideoEditorClient'


const mocks = vi.hoisted(() => ({
  generateScene: vi.fn(),
  runProjectAction: vi.fn(),
  useAutosave: vi.fn(),
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
  useTextVideoAutosave: mocks.useAutosave,
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
    projectDocument,
    onGenerateScenePlan,
  }: {
    projectDocument: { title: string }
    onGenerateScenePlan(input: {
      scope: 'all' | 'selected'
      selected_scene_id: string
      direction: string
    }): Promise<void>
  }) => (
    <>
      <p>{projectDocument.title}</p>
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
    </>
  ),
}))

describe('TextVideoEditorClient scene action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const project = makeVideoReadyProject()
    mocks.useAutosave.mockReturnValue(mocks.autosave)
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

  it('adopts the canonical project returned by autosave', () => {
    const project = makeVideoReadyProject({ title: '本地标题' })
    render(<TextVideoEditorClient initialProject={project} />)
    const options = mocks.useAutosave.mock.calls[0]?.[0] as {
      onSavedProject?: (saved: typeof project) => void
    }

    act(() => {
      options.onSavedProject?.({
        ...project,
        title: '数据库规范标题',
      })
    })

    expect(screen.getByText('数据库规范标题')).toBeInTheDocument()
  })
})
