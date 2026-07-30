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
    onProjectChange,
    onApplyTemplateSettings,
  }: {
    projectDocument: ReturnType<typeof makeVideoReadyProject>
    onGenerateScenePlan(input: {
      scope: 'all' | 'selected'
      selected_scene_id: string
      direction: string
    }): Promise<void>
    onProjectChange(project: ReturnType<typeof makeVideoReadyProject>): void
    onApplyTemplateSettings(
      props: Record<string, unknown>,
    ): Promise<void>
  }) => (
    <>
      <p>{projectDocument.title}</p>
      <p>{String(projectDocument.render_input.templateProps.brandTitle)}</p>
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
      <button
        type="button"
        onClick={() => onProjectChange({
          ...projectDocument,
          title: '立即变更',
        })}
      >
        测试普通变更
      </button>
      <button
        type="button"
        onClick={() => void onApplyTemplateSettings({
          ...projectDocument.render_input.templateProps,
          brandTitle: 'WORK LEVEL',
        })}
      >
        测试应用模板视觉
      </button>
    </>
  ),
}))

describe('TextVideoEditorClient scene action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const project = makeVideoReadyProject()
    mocks.useAutosave.mockReturnValue(mocks.autosave)
    mocks.autosave.flush.mockResolvedValue({
      project,
      dirtyVersion: 0,
    })
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

  it('stages ordinary project changes before updating React state', async () => {
    const user = userEvent.setup()
    const project = makeVideoReadyProject()
    render(<TextVideoEditorClient initialProject={project} />)

    await user.click(screen.getByRole('button', {
      name: '测试普通变更',
    }))

    expect(mocks.autosave.markDirty).toHaveBeenCalledWith(
      expect.objectContaining({ title: '立即变更' }),
    )
    expect(screen.getByText('立即变更')).toBeInTheDocument()
  })

  it('flushes template settings immediately and keeps the canonical save result', async () => {
    const user = userEvent.setup()
    const project = makeVideoReadyProject({
      output_asset_url: '/api/uploads/previous.mp4',
      output_stale: true,
    })
    render(<TextVideoEditorClient initialProject={project} />)
    const options = mocks.useAutosave.mock.calls[0]?.[0] as {
      onSavedProject?: (saved: typeof project) => void
    }
    mocks.autosave.flush.mockImplementation(async () => {
      const canonical = {
        ...project,
        revision: 2,
        render_input: {
          ...project.render_input,
          templateProps: {
            ...project.render_input.templateProps,
            brandTitle: 'SERVER CANONICAL',
          },
        },
      }
      options.onSavedProject?.(canonical)
      return { project: canonical, dirtyVersion: 1 }
    })

    await user.click(screen.getByRole('button', {
      name: '测试应用模板视觉',
    }))

    await waitFor(() => expect(mocks.autosave.flush).toHaveBeenCalledOnce())
    expect(mocks.autosave.markDirty).toHaveBeenCalledWith(
      expect.objectContaining({
        output_asset_url: '/api/uploads/previous.mp4',
        render_input: expect.objectContaining({
          templateProps: expect.objectContaining({
            brandTitle: 'WORK LEVEL',
          }),
        }),
      }),
    )
    expect(mocks.autosave.markDirty.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.autosave.flush.mock.invocationCallOrder[0])
    expect(await screen.findByText('SERVER CANONICAL')).toBeInTheDocument()
  })
})
