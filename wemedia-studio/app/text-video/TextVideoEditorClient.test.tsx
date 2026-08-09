// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  makeSpeechSegment,
  makeTextVideoProject,
  makeVideoReadyProject,
} from '@/lib/text-video/test-fixtures'

import { TextVideoEditorClient } from './TextVideoEditorClient'


const mocks = vi.hoisted(() => ({
  audioPrepared: vi.fn(),
  buildMaster: vi.fn(),
  confirmSpeech: vi.fn(),
  generateScene: vi.fn(),
  renderVideo: vi.fn(),
  runProjectAction: vi.fn(),
  retryProjectJob: vi.fn(),
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
    buildTextVideoMasterAudio: mocks.buildMaster,
    confirmTextVideoSpeechSegment: mocks.confirmSpeech,
    generateTextVideoScenePlan: mocks.generateScene,
    renderTextVideoProject: mocks.renderVideo,
  }
})

vi.mock('./useTextVideoAutosave', () => ({
  useTextVideoAutosave: mocks.useAutosave,
}))

vi.mock('./useTextVideoProjectActions', () => ({
  useTextVideoProjectActions: () => ({
    actionStates: {},
    runProjectAction: mocks.runProjectAction,
    retryProjectJob: mocks.retryProjectJob,
  }),
}))

vi.mock('./TextVideoWorkbench', () => ({
  TextVideoWorkbench: ({
    projectDocument,
    onConfirmSpeechSegment,
    onGenerateScenePlan,
    onProjectChange,
    onRealignMasterAudio,
    onApplyTemplate,
    onApplyTemplateSettings,
    onPrepareAudioStage,
    onRenderVideo,
  }: {
    projectDocument: ReturnType<typeof makeVideoReadyProject>
    onConfirmSpeechSegment(segment: { id: string }): void
    onRealignMasterAudio(jobId: number): void
    onGenerateScenePlan(input: {
      scope: 'all' | 'selected'
      selected_scene_id: string
      direction: string
    }): Promise<void>
    onProjectChange(project: ReturnType<typeof makeVideoReadyProject>): void
    onApplyTemplateSettings(
      props: Record<string, unknown>,
    ): Promise<void>
    onApplyTemplate(
      templateId: string,
      templateVersion: number,
      props: Record<string, unknown>,
    ): Promise<void>
    onPrepareAudioStage(): Promise<ReturnType<typeof makeVideoReadyProject>>
    onRenderVideo(): void
  }) => (
    <>
      <p>{projectDocument.title}</p>
      <p>{String(projectDocument.render_input.templateProps.brandTitle)}</p>
      <button
        type="button"
        onClick={onRenderVideo}
      >
        测试生成视频
      </button>
      <button
        type="button"
        onClick={() => onConfirmSpeechSegment(projectDocument.paragraphs[0])}
      >
        测试确认配音
      </button>
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
      <button
        type="button"
        onClick={() => void onApplyTemplate(
          'kinetic-punch-v1',
          1,
          {
            style: 'kinetic-punch',
            palette: 'night',
            brandTitle: 'EDIORA',
            showBrand: true,
            accentColor: '#D8FF3E',
            showProgress: true,
          },
        )}
      >
        测试切换模板
      </button>
      <button
        type="button"
        onClick={() => onRealignMasterAudio(316)}
      >
        测试重新对齐
      </button>
      <button
        type="button"
        onClick={() => {
          void onPrepareAudioStage().then(saved => {
            mocks.audioPrepared(saved.revision)
          })
        }}
      >
        测试进入配音
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
    mocks.renderVideo.mockResolvedValue({ jobs: [], project })
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

  it('launches the durable MP4 render with the saved revision', async () => {
    const user = userEvent.setup()
    const project = makeVideoReadyProject()
    render(<TextVideoEditorClient initialProject={project} />)

    await user.click(screen.getByRole('button', {
      name: '测试生成视频',
    }))

    await waitFor(() => {
      expect(mocks.runProjectAction).toHaveBeenCalledWith(
        'render:mp4',
        expect.any(Function),
      )
    })
    expect(mocks.renderVideo).toHaveBeenCalledWith(
      project.id,
      project.revision,
    )
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

  it('flushes the current draft before preparing the audio stage', async () => {
    const user = userEvent.setup()
    const project = makeTextVideoProject()
    mocks.autosave.flush.mockResolvedValue({
      project: { ...project, revision: 7 },
      dirtyVersion: 2,
    })
    render(<TextVideoEditorClient initialProject={project} />)

    await user.click(screen.getByRole('button', {
      name: '测试进入配音',
    }))

    expect(mocks.autosave.flush).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(mocks.audioPrepared).toHaveBeenCalledWith(7)
    })
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

  it('persists a template identity and its matching default props together', async () => {
    const user = userEvent.setup()
    const project = makeVideoReadyProject()
    render(<TextVideoEditorClient initialProject={project} />)

    await user.click(screen.getByRole('button', {
      name: '测试切换模板',
    }))

    await waitFor(() => expect(mocks.autosave.flush).toHaveBeenCalledOnce())
    expect(mocks.autosave.markDirty).toHaveBeenCalledWith(
      expect.objectContaining({
        render_input: expect.objectContaining({
          templateId: 'kinetic-punch-v1',
          templateVersion: 1,
          templateProps: {
            style: 'kinetic-punch',
            palette: 'night',
            brandTitle: 'EDIORA',
            showBrand: true,
            accentColor: '#D8FF3E',
            showProgress: true,
          },
        }),
      }),
    )
    expect(mocks.autosave.markDirty.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.autosave.flush.mock.invocationCallOrder[0])
  })

  it('automatically reuses a confirmed single segment as master audio', async () => {
    const user = userEvent.setup()
    const ready = makeTextVideoProject({
      script: '唯一段落',
      stage: 'audio',
      paragraphs: [makeSpeechSegment('only', '唯一段落', {
        status: 'ready',
        audio_url: '/api/uploads/only.mp3',
        duration: 2,
        generation_revision: 3,
        source_hash: 'a'.repeat(64),
      })],
    })
    const confirmed = {
      ...ready,
      paragraphs: [{
        ...ready.paragraphs[0],
        status: 'confirmed' as const,
      }],
    }
    mocks.confirmSpeech.mockResolvedValue(confirmed)
    mocks.buildMaster.mockResolvedValue({
      jobs: [{
        id: 71,
        flow: 'text_video_master_audio',
        target_id: ready.id,
      }],
      project: confirmed,
    })
    mocks.runProjectAction.mockImplementation(
      async (
        _key: string,
        launch: (saved: typeof ready) => Promise<unknown>,
      ) => {
        await launch(ready)
      },
    )

    render(<TextVideoEditorClient initialProject={ready} />)
    await user.click(screen.getByRole('button', {
      name: '测试确认配音',
    }))

    await waitFor(() => {
      expect(mocks.confirmSpeech).toHaveBeenCalledWith(
        ready.id,
        'only',
        {
          revision: ready.revision,
          generation_revision: 3,
          source_hash: 'a'.repeat(64),
        },
      )
    })
    expect(mocks.buildMaster).toHaveBeenCalledWith(
      confirmed.id,
      confirmed.revision,
    )
  })

  it('repairs an already-confirmed single segment on editor load', async () => {
    const confirmed = makeTextVideoProject({
      script: '唯一段落',
      stage: 'audio',
      paragraphs: [makeSpeechSegment('only', '唯一段落', {
        status: 'confirmed',
        audio_url: '/api/uploads/only.mp3',
        duration: 2,
        generation_revision: 3,
        source_hash: 'a'.repeat(64),
      })],
    })
    mocks.buildMaster.mockResolvedValue({
      jobs: [{
        id: 72,
        flow: 'text_video_master_audio',
        target_id: confirmed.id,
      }],
      project: confirmed,
    })
    mocks.runProjectAction.mockImplementation(
      async (
        _key: string,
        launch: (saved: typeof confirmed) => Promise<unknown>,
      ) => {
        await launch(confirmed)
      },
    )

    render(<TextVideoEditorClient initialProject={confirmed} />)

    await waitFor(() => {
      expect(mocks.runProjectAction).toHaveBeenCalledWith(
        'master',
        expect.any(Function),
      )
    })
    expect(mocks.buildMaster).toHaveBeenCalledWith(
      confirmed.id,
      confirmed.revision,
    )
  })

  it('starts a fresh timeline job after a configuration failure', async () => {
    const user = userEvent.setup()
    const project = makeVideoReadyProject()
    mocks.buildMaster.mockResolvedValue({
      jobs: [{
        id: 73,
        flow: 'text_video_master_audio',
        target_id: project.id,
      }],
      project,
    })

    render(<TextVideoEditorClient initialProject={project} />)
    await user.click(screen.getByRole('button', {
      name: '测试重新对齐',
    }))

    await waitFor(() => {
      expect(mocks.runProjectAction).toHaveBeenCalledWith(
        'master',
        expect.any(Function),
      )
    })
    expect(mocks.buildMaster).toHaveBeenCalledWith(
      project.id,
      project.revision,
    )
    expect(mocks.retryProjectJob).not.toHaveBeenCalled()
  })
})
