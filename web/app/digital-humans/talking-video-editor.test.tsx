// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateTalkingVideo: vi.fn(),
  createTalkingVideoRender: vi.fn(),
  createTalkingVideo: vi.fn(),
  getTalkingVideo: vi.fn(),
  selectTalkingVideoRender: vi.fn(),
  deleteTalkingVideoRender: vi.fn(),
  planTalkingVideoShots: vi.fn(),
  renderPendingTalkingVideoShots: vi.fn(),
  renderTalkingVideoShot: vi.fn(),
  saveTalkingVideoShots: vi.fn(),
  stitchTalkingVideo: vi.fn(),
}))

vi.mock('@/lib/api/jobs', () => ({
  cancelJob: vi.fn(),
}))

vi.mock('@/lib/api/digital-humans', () => ({
  updateTalkingVideo: mocks.updateTalkingVideo,
  createTalkingVideoRender: mocks.createTalkingVideoRender,
  createTalkingVideo: mocks.createTalkingVideo,
  getTalkingVideo: mocks.getTalkingVideo,
  selectTalkingVideoRender: mocks.selectTalkingVideoRender,
  deleteTalkingVideoRender: mocks.deleteTalkingVideoRender,
  planTalkingVideoShots: mocks.planTalkingVideoShots,
  renderPendingTalkingVideoShots: mocks.renderPendingTalkingVideoShots,
  renderTalkingVideoShot: mocks.renderTalkingVideoShot,
  saveTalkingVideoShots: mocks.saveTalkingVideoShots,
  stitchTalkingVideo: mocks.stitchTalkingVideo,
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
  look_asset_id: null,
  shots: [],
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


function mediaAsset(
  id: number,
  kind: 'image' | 'video' | 'audio',
  title: string,
  filename: string,
) {
  return {
    id,
    asset_type: 'media' as const,
    media_kind: kind,
    title,
    content: '',
    url: `/api/uploads/${filename}`,
    media_type: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/wav',
    filename,
    directory: '',
    tags: [] as string[],
    source: 'upload',
    created_at: '',
    updated_at: '',
  }
}


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

  it('does not call a ComfyUI stitch “HeyGen 正在处理”', () => {
    render(
      <RenderVersionsPanel
        projectId={project.id}
        renders={[{
          ...renderV1,
          status: 'running',
          digital_human_snapshot: {
            ...renderV1.digital_human_snapshot,
            provider: 'comfyui',
          },
        }]}
        currentRenderId={renderV1.id}
      />,
    )

    expect(screen.getByText('正在拼接成片')).toBeTruthy()
    expect(screen.queryByText('HeyGen 正在处理')).toBeNull()
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
  })

  it('tells the user a ready ComfyUI role still needs a voice sample', () => {
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      voice_sample_asset_id: null,
      look_asset_id: 1013,
    }
    render(
      <TalkingVideoEditor
        project={{
          ...project,
          digital_human_id: comfyRole.id,
          role: comfyRole,
          shots: [{
            id: 'shot-1',
            duration_sec: 5,
            framing: 'medium',
            spoken_text: '今天我们来讲一下',
            motion_prompt: '',
            first_frame_asset_id: null,
            clip_asset_id: null,
            status: 'draft',
            job_id: null,
            error: '',
            workflow_version: '',
            seed: null,
            provider_state: {},
          }],
        }}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    expect(screen.getByText('还缺 2–15 秒声音样本，请先到角色里补上')).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成这一镜' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '全部入队生成' })).toBeDisabled()
    expect(screen.getByText('这一镜还没有成片，生成后可在这里试看')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '分镜 1' }))
    fireEvent.click(screen.getByRole('tab', { name: '提示词' }))
    expect(screen.getByLabelText('镜头 1 提示词')).toBeTruthy()
    expect(
      (screen.getByLabelText('镜头 1 提示词') as HTMLTextAreaElement).value,
    ).toContain('Video Description:')
  })

  it('saves an edited H3 prompt on the active ComfyUI shot', async () => {
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      look_asset_id: 1013,
    }
    const comfyShot = {
      id: 'shot-1',
      duration_sec: 5,
      framing: 'medium' as const,
      spoken_text: '今天我们来讲一下',
      motion_prompt: '',
      render_prompt: 'OLD PROMPT',
      first_frame_asset_id: null,
      clip_asset_id: null,
      status: 'draft' as const,
      job_id: null,
      error: '',
      workflow_version: '',
      seed: null,
      provider_state: {},
    }
    mocks.saveTalkingVideoShots.mockImplementation(async (_id, nextShots) => ({
      ...project,
      digital_human_id: comfyRole.id,
      role: comfyRole,
      shots: nextShots,
    }))
    render(
      <TalkingVideoEditor
        project={{
          ...project,
          digital_human_id: comfyRole.id,
          role: comfyRole,
          shots: [comfyShot],
        }}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '分镜 1' }))
    fireEvent.click(screen.getByRole('tab', { name: '提示词' }))
    fireEvent.change(screen.getByLabelText('镜头 1 提示词'), {
      target: { value: 'CUSTOM H3 PROMPT' },
    })
    await vi.waitFor(() => {
      expect(mocks.saveTalkingVideoShots).toHaveBeenCalledWith(
        project.id,
        expect.arrayContaining([
          expect.objectContaining({ render_prompt: 'CUSTOM H3 PROMPT' }),
        ]),
      )
    })
  })

  it('shows referenced media next to the H3 prompt', () => {
    const look = mediaAsset(1013, 'image', 'MK 定妆图', 'look.jpg')
    const portrait = mediaAsset(1014, 'image', 'MK 正面照', 'portrait.jpg')
    const voice = mediaAsset(22, 'audio', 'MK 音色', 'voice.wav')
    const clip = mediaAsset(77, 'video', '分镜成片', 'shot-1.mp4')
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      look_asset_id: look.id,
      look,
      portrait_asset_id: portrait.id,
      portrait,
      voice_sample_asset_id: voice.id,
      voice_sample: voice,
    }
    const draftShot = {
      id: 'shot-1',
      duration_sec: 5,
      framing: 'medium' as const,
      spoken_text: '今天我们来讲一下',
      motion_prompt: '',
      first_frame_asset_id: null,
      clip_asset_id: clip.id,
      clip_asset: clip,
      status: 'succeeded' as const,
      job_id: null,
      error: '',
      workflow_version: '',
      seed: null,
      provider_state: {},
    }
    const nextShot = {
      ...draftShot,
      id: 'shot-2',
      framing: 'close' as const,
      spoken_text: '下一句',
      clip_asset_id: null,
      clip_asset: null,
      status: 'draft' as const,
    }
    render(
      <TalkingVideoEditor
        project={{
          ...project,
          digital_human_id: comfyRole.id,
          role: comfyRole,
          shots: [draftShot, nextShot],
        }}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '分镜 2' }))
    fireEvent.click(screen.getByTestId('talking-shot-shot-1'))
    fireEvent.click(screen.getByRole('tab', { name: '提示词' }))
    expect(screen.getByRole('img', { name: '<Picture 1> 定妆图' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/uploads/look.jpg'),
    )
    expect(screen.getByRole('img', { name: '<Picture 2> 环境图' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/uploads/studio.jpg'),
    )
    expect(screen.getByLabelText('<Audio 1> 音色样本')).toHaveAttribute(
      'src',
      expect.stringContaining('/api/uploads/voice.wav'),
    )
    expect(screen.queryByLabelText('<Picture 3> 上一镜')).toBeNull()
    expect(screen.queryByRole('img', { name: '<Picture 3> 正面照' })).toBeNull()

    fireEvent.click(screen.getByTestId('talking-shot-shot-2'))
    expect(screen.queryByLabelText('<Picture 3> 上一镜')).toBeNull()
    expect(screen.getByRole('img', { name: '<Picture 3> 正面照' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/uploads/portrait.jpg'),
    )
  })

  it('plans the full script and enqueues every pending ComfyUI shot', async () => {
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      look_asset_id: 1013,
    }
    const comfyProject = {
      ...project,
      digital_human_id: comfyRole.id,
      role: comfyRole,
      script: '今天讲本地部署。然后看环境准备。',
      min_shot_seconds: 4,
      max_shot_seconds: 5,
      shots: [{
        id: 'shot-1',
        duration_sec: 5,
        framing: 'medium' as const,
        spoken_text: '旧镜头',
        motion_prompt: '',
        first_frame_asset_id: null,
        clip_asset_id: null,
        status: 'draft' as const,
        job_id: null,
        error: '',
        workflow_version: '',
        seed: null,
        provider_state: {},
      }],
    }
    const planned = {
      ...comfyProject,
      shots: [
        { ...comfyProject.shots[0], id: 'shot-a', spoken_text: '今天讲本地部署。', framing: 'close' as const },
        { ...comfyProject.shots[0], id: 'shot-b', spoken_text: '然后看环境准备。', framing: 'wide' as const },
      ],
    }
    mocks.planTalkingVideoShots.mockResolvedValue(planned)
    mocks.renderPendingTalkingVideoShots.mockResolvedValue({
      ...planned,
      shots: planned.shots.map(shot => ({ ...shot, status: 'queued' as const, job_id: 9 })),
    })
    const user = userEvent.setup()
    render(
      <TalkingVideoEditor
        project={comfyProject}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    expect(screen.getByRole('tab', { name: '整稿' })).toBeTruthy()
    expect(screen.getByLabelText('全文口播')).toBeTruthy()
    expect(screen.getByLabelText('整片语气')).toBeTruthy()
    expect(screen.getByLabelText('整片状态')).toBeTruthy()
    expect(screen.getByText(/单镜 4–5 秒/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'AI 规划分镜' }))
    expect(mocks.planTalkingVideoShots).toHaveBeenCalledWith(
      comfyProject.id,
      '今天讲本地部署。然后看环境准备。',
    )
    expect(screen.getByLabelText('镜头 1 口播句')).toBeTruthy()
    expect(screen.getByLabelText('镜头 1 语气')).toBeTruthy()
    expect(screen.getByLabelText('镜头 1 状态')).toBeTruthy()
    expect(
      (screen.getByLabelText('镜头 1 口播句') as HTMLTextAreaElement).value,
    ).toBe('今天讲本地部署。')
    await user.click(screen.getByRole('button', { name: '全部入队生成' }))
    expect(mocks.renderPendingTalkingVideoShots).toHaveBeenCalledWith(comfyProject.id)
  })

  it('plays the selected ComfyUI shot clip on the workbench', () => {
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      look_asset_id: 1013,
    }
    render(
      <TalkingVideoEditor
        project={{
          ...project,
          digital_human_id: comfyRole.id,
          role: comfyRole,
          shots: [{
            id: 'shot-1',
            duration_sec: 5,
            framing: 'medium',
            spoken_text: '今天我们来讲一下',
            motion_prompt: '',
            first_frame_asset_id: null,
            clip_asset_id: 77,
            clip_asset: {
              id: 77,
              asset_type: 'media',
              media_kind: 'video',
              title: 'shot',
              content: '',
              url: '/api/uploads/shot.mp4',
              media_type: 'video/mp4',
              filename: 'shot.mp4',
              directory: '',
              tags: [],
              source: 'upload',
              created_at: '',
              updated_at: '',
            },
            status: 'succeeded',
            job_id: 9,
            error: '',
            workflow_version: 'h3-ref2va-v1',
            seed: 1,
            provider_state: {},
          }],
          current_render_id: renderV1.id,
          renders: [{
            ...renderV1,
            video_asset: {
              id: 8,
              asset_type: 'media',
              media_kind: 'video',
              title: 'final',
              content: '',
              url: '/api/uploads/final.mp4',
              media_type: 'video/mp4',
              filename: 'final.mp4',
              directory: '',
              tags: [],
              source: 'upload',
              created_at: '',
              updated_at: '',
            },
          }],
        }}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    expect(screen.getByLabelText('本镜预览')).toBeTruthy()
    expect(
      (screen.getByLabelText('本镜预览') as HTMLVideoElement).getAttribute('src'),
    ).toContain('/api/uploads/shot.mp4')
    fireEvent.click(screen.getByRole('tab', { name: '成片' }))
    expect(screen.getByLabelText('成片预览')).toBeTruthy()
    expect(
      (screen.getByLabelText('成片预览') as HTMLVideoElement).getAttribute('src'),
    ).toContain('/api/uploads/final.mp4')
  })

  it('asks before regenerating a finished ComfyUI clip', async () => {
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      look_asset_id: 1013,
    }
    const succeededShot = {
      id: 'shot-1',
      duration_sec: 5,
      framing: 'medium' as const,
      spoken_text: '今天我们来讲一下',
      motion_prompt: '',
      first_frame_asset_id: null,
      clip_asset_id: 77,
      clip_asset: {
        id: 77,
        asset_type: 'media' as const,
        media_kind: 'video' as const,
        title: 'shot',
        content: '',
        url: '/api/uploads/shot.mp4',
        media_type: 'video/mp4',
        filename: 'shot.mp4',
        directory: '',
        tags: [],
        source: 'upload',
        created_at: '',
        updated_at: '',
      },
      status: 'succeeded' as const,
      job_id: 9,
      error: '',
      workflow_version: 'h3-ref2va-v1',
      seed: 1,
      provider_state: {},
    }
    mocks.renderTalkingVideoShot.mockResolvedValue({
      ...project,
      digital_human_id: comfyRole.id,
      role: comfyRole,
      shots: [{ ...succeededShot, status: 'queued' as const, job_id: 12 }],
    })
    render(
      <TalkingVideoEditor
        project={{
          ...project,
          digital_human_id: comfyRole.id,
          role: comfyRole,
          shots: [succeededShot],
        }}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '重新生成这一镜' }))
    expect(mocks.renderTalkingVideoShot).not.toHaveBeenCalled()
    expect(screen.getByText('重新生成这一镜？')).toBeTruthy()
    expect(
      screen.getByText(/这一镜已有成片。确认后会按当前口播和提示词重跑/),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(mocks.renderTalkingVideoShot).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '重新生成这一镜' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重新生成' }))
    await vi.waitFor(() => {
      expect(mocks.renderTalkingVideoShot).toHaveBeenCalledWith(project.id, 'shot-1')
    })
  })

  it('generates a draft ComfyUI shot without asking for confirmation', async () => {
    const comfyRole = {
      ...readyRole,
      id: 2,
      name: 'MK',
      provider: 'comfyui' as const,
      look_asset_id: 1013,
    }
    const draftShot = {
      id: 'shot-1',
      duration_sec: 5,
      framing: 'medium' as const,
      spoken_text: '今天我们来讲一下',
      motion_prompt: '',
      first_frame_asset_id: null,
      clip_asset_id: null,
      status: 'draft' as const,
      job_id: null,
      error: '',
      workflow_version: '',
      seed: null,
      provider_state: {},
    }
    mocks.renderTalkingVideoShot.mockResolvedValue({
      ...project,
      digital_human_id: comfyRole.id,
      role: comfyRole,
      shots: [{ ...draftShot, status: 'queued' as const, job_id: 12 }],
    })
    render(
      <TalkingVideoEditor
        project={{
          ...project,
          digital_human_id: comfyRole.id,
          role: comfyRole,
          shots: [draftShot],
        }}
        roles={[comfyRole]}
        saveProject={mocks.updateTalkingVideo}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '生成这一镜' }))
    expect(screen.queryByText('重新生成这一镜？')).toBeNull()
    await vi.waitFor(() => {
      expect(mocks.renderTalkingVideoShot).toHaveBeenCalledWith(project.id, 'shot-1')
    })
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
