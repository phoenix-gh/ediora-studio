// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateTalkingVideo: vi.fn(),
  createTalkingVideoRender: vi.fn(),
  createTalkingVideo: vi.fn(),
  getTalkingVideo: vi.fn(),
  selectTalkingVideoRender: vi.fn(),
  deleteTalkingVideoRender: vi.fn(),
}))

vi.mock('@/lib/api/digital-humans', () => ({
  updateTalkingVideo: mocks.updateTalkingVideo,
  createTalkingVideoRender: mocks.createTalkingVideoRender,
  createTalkingVideo: mocks.createTalkingVideo,
  getTalkingVideo: mocks.getTalkingVideo,
  selectTalkingVideoRender: mocks.selectTalkingVideoRender,
  deleteTalkingVideoRender: mocks.deleteTalkingVideoRender,
  generateTalkingScript: vi.fn(),
}))

import { RenderVersionsPanel } from './RenderVersionsPanel'
import { TalkingProjectList } from './TalkingProjectList'
import { TalkingVideoEditor } from './TalkingVideoEditor'
import type {
  DigitalHuman,
  TalkingVideoProject,
  TalkingVideoRender,
} from '@/lib/api/digital-humans'


const readyRole = {
  id: 3,
  name: '林晓',
  status: 'ready',
  provider: 'heygen',
  portrait_asset_id: 1,
  voice_sample_asset_id: 2,
  default_environment_asset_id: 4,
  look_asset_id: null,
  portrait: null,
  voice_sample: null,
  default_environment: null,
  look: null,
  heygen_avatar_group_id: 'group-1',
  heygen_avatar_id: 'avatar-1',
  heygen_voice_id: 'voice-1',
  provider_state: {},
  setup_job_id: 1,
  error: '',
  archived_at: null,
  created_at: '',
  updated_at: '',
} satisfies DigitalHuman

const renderV1 = {
  id: 10,
  project_id: 5,
  version: 1,
  status: 'succeeded',
  job_id: 1,
  script_snapshot: '第一版',
  digital_human_snapshot: {
    id: 3,
    name: '林晓',
    heygen_avatar_group_id: 'group-1',
    heygen_avatar_id: 'avatar-1',
    heygen_voice_id: 'voice-1',
  },
  environment_asset_id: 4,
  provider_state: {},
  heygen_environment_asset_id: 'asset-1',
  heygen_video_id: 'video-1',
  video_asset_id: 8,
  video_asset: null,
  error: '',
  created_at: '',
  completed_at: '',
} satisfies TalkingVideoRender

const renderV2 = { ...renderV1, id: 11, version: 2 }

const project = {
  id: 5,
  title: '新品介绍',
  digital_human_id: readyRole.id,
  script: '原脚本',
  script_source: 'manual',
  source_draft_id: null,
  environment_asset_id: null,
  effective_environment_asset_id: 4,
  current_render_id: null,
  role: readyRole,
  effective_environment: {
    id: 4,
    asset_type: 'media',
    media_kind: 'image',
    title: '演播室',
    content: '',
    url: '/api/uploads/studio.jpg',
    media_type: 'image/jpeg',
    filename: 'studio.jpg',
    directory: '',
    tags: [],
    source: 'upload',
    created_at: '',
    updated_at: '',
  },
  renders: [],
  created_at: '',
  updated_at: '',
} satisfies TalkingVideoProject


afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})


describe('talking video editor', () => {
  it('renders the approved three-column workbench', () => {
    render(
      <TalkingVideoEditor
        project={project}
        roles={[readyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    expect(screen.getByTestId('talking-config-column')).toBeTruthy()
    expect(screen.getByTestId('talking-script-column')).toBeTruthy()
    expect(screen.getByTestId('talking-render-column')).toBeTruthy()
    expect(screen.getByRole('combobox').textContent).toContain('林晓')
  })

  it('debounces script saves and never renders before explicit confirmation', async () => {
    mocks.updateTalkingVideo.mockResolvedValue(project)
    const user = userEvent.setup()
    render(
      <TalkingVideoEditor
        project={project}
        roles={[readyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    await user.clear(screen.getByLabelText('口播脚本'))
    await user.type(screen.getByLabelText('口播脚本'), '新的内容')
    expect((screen.getByLabelText('口播脚本') as HTMLTextAreaElement).value).toBe('新的内容')
    expect(screen.getByText('4 字 · 手动编辑')).toBeTruthy()
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 700))
    })

    expect(mocks.updateTalkingVideo).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ script: '新的内容' }),
    )
    expect(mocks.createTalkingVideoRender).not.toHaveBeenCalled()
  })

  it('flushes a pending script save when switching projects', async () => {
    mocks.updateTalkingVideo.mockResolvedValue(project)
    const user = userEvent.setup()
    const view = render(
      <TalkingVideoEditor
        project={project}
        roles={[readyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    await user.clear(screen.getByLabelText('口播脚本'))
    await user.type(screen.getByLabelText('口播脚本'), '切换前保存')
    view.unmount()

    await vi.waitFor(() => {
      expect(mocks.updateTalkingVideo).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ script: '切换前保存' }),
      )
    })
  })

  it('keeps earlier successful versions after generating another render', () => {
    render(
      <RenderVersionsPanel
        projectId={project.id}
        renders={[renderV2, renderV1]}
        currentRenderId={renderV2.id}
      />,
    )

    expect(screen.getByText('版本 2')).toBeTruthy()
    expect(screen.getByText('版本 1')).toBeTruthy()
  })

  it('shows project and role labels instead of raw ids or statuses', async () => {
    const user = userEvent.setup()
    render(
      <TalkingProjectList
        projects={[{ ...project, renders: [renderV1] }]}
        roles={[readyRole]}
        selectedId={project.id}
        onSelect={vi.fn()}
        onCreated={vi.fn()}
      />,
    )

    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.queryByText('succeeded')).toBeNull()
    await user.click(screen.getByRole('button', { name: '新建口播作品' }))
    expect(screen.getByRole('combobox').textContent).toContain('林晓')
  })
})
