import { describe, expect, it, vi } from 'vitest'

import {
  type DigitalHumanJobDeps,
  runDigitalHumanRenderJob,
  runDigitalHumanSetupJob,
} from './digital-human-job'


function jobApi(flow: string, input: Record<string, unknown>) {
  let stepId = 0
  return {
    getJob: vi.fn().mockResolvedValue({
      id: 1,
      flow,
      title: 'job',
      status: 'queued',
      input,
      steps: [],
    }),
    startStep: vi.fn().mockImplementation(async () => ({ id: ++stepId })),
    completeStep: vi.fn().mockResolvedValue(undefined),
    failStep: vi.fn().mockResolvedValue(undefined),
    completeJob: vi.fn().mockResolvedValue(undefined),
    getRoleContext: vi.fn(),
    updateRole: vi.fn().mockResolvedValue(undefined),
    getRenderContext: vi.fn(),
    updateRender: vi.fn().mockResolvedValue(undefined),
    fetchLocalAsset: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      filename: 'asset.png',
    }),
    saveVideoAsset: vi.fn(),
  }
}


function heygenMock() {
  return {
    uploadAsset: vi.fn(),
    createPhotoAvatar: vi.fn(),
    getAvatar: vi.fn(),
    cloneVoice: vi.fn(),
    getVoice: vi.fn(),
    createVideo: vi.fn(),
    getVideo: vi.fn(),
  }
}


describe('digital-human durable jobs', () => {
  it('uploads portrait and voice then marks the role ready', async () => {
    const api = jobApi('digital_human_setup', { digital_human_id: 7 })
    api.getRoleContext.mockResolvedValue({
      id: 7,
      name: '林晓',
      status: 'processing',
      portrait: {
        url: '/api/uploads/portrait.png',
        media_type: 'image/png',
        filename: 'portrait.png',
      },
      voice_sample: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
      provider_state: {},
      heygen_avatar_group_id: '',
      heygen_avatar_id: '',
      heygen_voice_id: '',
    })
    const heygen = heygenMock()
    heygen.uploadAsset
      .mockResolvedValueOnce({ asset_id: 'portrait-hg' })
      .mockResolvedValueOnce({ asset_id: 'voice-hg' })
    heygen.createPhotoAvatar.mockResolvedValue({
      groupId: 'group-1',
      avatarId: 'avatar-1',
      status: 'processing',
    })
    heygen.getAvatar.mockResolvedValue({
      groupId: 'group-1',
      avatarId: 'avatar-1',
      status: 'completed',
    })
    heygen.cloneVoice.mockResolvedValue({ voiceId: 'voice-1' })
    heygen.getVoice.mockResolvedValue({
      voiceId: 'voice-1',
      status: 'complete',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanSetupJob(41, deps)

    expect(api.updateRole).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        status: 'ready',
        heygen_avatar_id: 'avatar-1',
        heygen_voice_id: 'voice-1',
      }),
    )
    expect(api.completeJob).toHaveBeenCalledWith(41)
  })

  it('reuses a persisted avatar id on a retried voice step', async () => {
    const api = jobApi('digital_human_setup', { digital_human_id: 7 })
    api.getRoleContext.mockResolvedValue({
      id: 7,
      name: '林晓',
      status: 'processing',
      portrait: {
        url: '/api/uploads/portrait.png',
        media_type: 'image/png',
        filename: 'portrait.png',
      },
      voice_sample: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
      provider_state: {
        avatar_id: 'avatar-1',
        avatar_group_id: 'group-1',
        voice_asset_id: 'voice-asset',
      },
      heygen_avatar_group_id: '',
      heygen_avatar_id: '',
      heygen_voice_id: '',
    })
    const heygen = heygenMock()
    heygen.getAvatar.mockResolvedValue({
      groupId: 'group-1',
      avatarId: 'avatar-1',
      status: 'completed',
    })
    heygen.cloneVoice.mockResolvedValue({ voiceId: 'voice-1' })
    heygen.getVoice.mockResolvedValue({
      voiceId: 'voice-1',
      status: 'complete',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanSetupJob(42, deps)

    expect(heygen.createPhotoAvatar).not.toHaveBeenCalled()
    expect(heygen.uploadAsset).not.toHaveBeenCalled()
  })

  it('downloads HeyGen output and saves a local creative video asset', async () => {
    const api = jobApi('digital_human_render', { render_id: 11 })
    api.getRenderContext.mockResolvedValue({
      id: 11,
      project_id: 5,
      version: 1,
      status: 'queued',
      script: '大家好',
      digital_human: {
        name: '林晓',
        heygen_avatar_id: 'avatar-1',
        heygen_voice_id: 'voice-1',
      },
      environment: {
        url: '/api/uploads/environment.png',
        media_type: 'image/png',
        filename: 'environment.png',
      },
      provider_state: {},
      heygen_environment_asset_id: '',
      heygen_video_id: '',
    })
    api.fetchLocalAsset
      .mockResolvedValueOnce({
        bytes: new Uint8Array([1]),
        mediaType: 'image/png',
        filename: 'environment.png',
      })
      .mockResolvedValueOnce({
        bytes: new Uint8Array([0, 0, 0, 24]),
        mediaType: 'video/mp4',
        filename: 'result.mp4',
      })
    api.saveVideoAsset.mockResolvedValue({
      id: 88,
      url: '/api/uploads/result.mp4',
    })
    const heygen = heygenMock()
    heygen.uploadAsset.mockResolvedValue({ asset_id: 'background-1' })
    heygen.createVideo.mockResolvedValue({
      videoId: 'video-1',
      status: 'waiting',
    })
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-1',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanRenderJob(51, deps)

    expect(api.saveVideoAsset).toHaveBeenCalledWith(
      51,
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ mediaType: 'video/mp4' }),
    )
    expect(api.updateRender).toHaveBeenLastCalledWith(
      11,
      expect.objectContaining({
        status: 'succeeded',
        heygen_video_id: 'video-1',
        video_asset_id: 88,
      }),
    )
    expect(api.completeJob).toHaveBeenCalledWith(51)
  })
})
