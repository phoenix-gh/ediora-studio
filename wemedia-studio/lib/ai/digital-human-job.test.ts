import { describe, expect, it, vi } from 'vitest'

import {
  type DigitalHumanJobDeps,
  retryableHttpStatus,
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
    composeLook: vi.fn(),
    updateRole: vi.fn().mockResolvedValue(undefined),
    getRenderContext: vi.fn(),
    updateRender: vi.fn().mockResolvedValue(undefined),
    fetchLocalAsset: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/png',
      filename: 'asset.png',
    }),
    saveVideoAsset: vi.fn(),
    deleteAsset: vi.fn().mockResolvedValue(undefined),
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
  it('does not retry permanent local asset and upload failures', () => {
    expect(retryableHttpStatus(404)).toBe(false)
    expect(retryableHttpStatus(413)).toBe(false)
    expect(retryableHttpStatus(429)).toBe(true)
    expect(retryableHttpStatus(503)).toBe(true)
  })

  it('marks a non-MP4 provider output as non-retryable', async () => {
    const api = jobApi('digital_human_render', { render_id: 17 })
    api.getRenderContext.mockResolvedValue({
      id: 17,
      project_id: 5,
      version: 7,
      status: 'running',
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
      provider_state: {
        environment_asset_id: 'background-7',
        video_id: 'video-7',
      },
      heygen_environment_asset_id: 'background-7',
      heygen_video_id: 'video-7',
    })
    api.fetchLocalAsset.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'text/html',
      filename: 'error.html',
    })
    const heygen = heygenMock()
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-7',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result-7.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanRenderJob(58, deps)).rejects.toThrow(
      'HeyGen 成片格式异常',
    )

    expect(api.failStep).toHaveBeenLastCalledWith(
      58,
      expect.any(Number),
      expect.any(Error),
      false,
    )
  })

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

    expect(heygen.uploadAsset).toHaveBeenNthCalledWith(
      1,
      expect.any(Uint8Array),
      'image/png',
      'asset.png',
      'digital-human:7:setup:41:portrait',
    )
    expect(heygen.createPhotoAvatar).toHaveBeenCalledWith({
      name: '林晓',
      assetId: 'portrait-hg',
      idempotencyKey: 'digital-human:7:setup:41:avatar',
    })
    expect(heygen.uploadAsset).toHaveBeenNthCalledWith(
      2,
      expect.any(Uint8Array),
      'image/png',
      'asset.png',
      'digital-human:7:setup:41:voice-sample',
    )
    expect(heygen.cloneVoice).toHaveBeenCalledWith({
      name: '林晓',
      assetId: 'voice-hg',
    })
    expect(api.updateRole).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        status: 'ready',
        heygen_avatar_id: 'avatar-1',
        heygen_voice_id: 'voice-1',
      }),
      41,
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

  it('does not reuse a promoted avatar when provider state requests a rebuild', async () => {
    const api = jobApi('digital_human_setup', { digital_human_id: 7 })
    api.getRoleContext.mockResolvedValue({
      id: 7,
      name: '林晓',
      status: 'processing',
      portrait: {
        url: '/api/uploads/new-portrait.png',
        media_type: 'image/png',
        filename: 'new-portrait.png',
      },
      voice_sample: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
      provider_state: {
        voice_asset_id: 'voice-asset',
        voice_id: 'voice-stable',
      },
      heygen_avatar_group_id: 'group-old',
      heygen_avatar_id: 'avatar-old',
      heygen_voice_id: 'voice-stable',
    })
    const heygen = heygenMock()
    heygen.uploadAsset.mockResolvedValue({ asset_id: 'portrait-new-asset' })
    heygen.createPhotoAvatar.mockResolvedValue({
      groupId: 'group-new',
      avatarId: 'avatar-new',
      status: 'processing',
    })
    heygen.getAvatar.mockResolvedValue({
      groupId: 'group-new',
      avatarId: 'avatar-new',
      status: 'completed',
    })
    heygen.getVoice.mockResolvedValue({
      voiceId: 'voice-stable',
      status: 'complete',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanSetupJob(43, deps)

    expect(heygen.createPhotoAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'portrait-new-asset' }),
    )
    expect(heygen.cloneVoice).not.toHaveBeenCalled()
    expect(api.updateRole).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        status: 'ready',
        heygen_avatar_id: 'avatar-new',
        heygen_voice_id: 'voice-stable',
      }),
      43,
    )
  })

  it('retries only the failed voice step after the job creates a new attempt', async () => {
    const api = jobApi('digital_human_setup', { digital_human_id: 7 })
    api.getJob.mockResolvedValue({
      id: 44,
      flow: 'digital_human_setup',
      title: 'retry voice',
      status: 'queued',
      input: { digital_human_id: 7 },
      steps: [
        {
          id: 1,
          key: 'heygen_avatar',
          attempt: 1,
          status: 'succeeded',
          output: {
            avatar_id: 'avatar-1',
            avatar_group_id: 'group-1',
          },
        },
        {
          id: 2,
          key: 'heygen_voice',
          attempt: 1,
          status: 'failed',
          output: {},
        },
        {
          id: 3,
          key: 'heygen_voice',
          attempt: 2,
          status: 'queued',
          output: {},
        },
      ],
    })
    api.getRoleContext.mockResolvedValue({
      id: 7,
      name: '林晓',
      status: 'failed',
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
    heygen.cloneVoice.mockResolvedValue({ voiceId: 'voice-2' })
    heygen.getVoice.mockResolvedValue({
      voiceId: 'voice-2',
      status: 'complete',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanSetupJob(44, deps)

    expect(heygen.uploadAsset).not.toHaveBeenCalled()
    expect(heygen.createPhotoAvatar).not.toHaveBeenCalled()
    expect(heygen.getAvatar).not.toHaveBeenCalled()
    expect(heygen.cloneVoice).toHaveBeenCalledOnce()
    expect(api.startStep).not.toHaveBeenCalledWith(44, 'heygen_avatar')
    expect(api.startStep).toHaveBeenCalledWith(44, 'heygen_voice')
  })

  it('marks a terminal provider processing failure as non-retryable', async () => {
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
        voice_id: 'voice-invalid',
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
    heygen.getVoice.mockResolvedValue({
      voiceId: 'voice-invalid',
      status: 'failed',
      error: 'Audio is too short',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanSetupJob(45, deps)).rejects.toThrow(
      'Audio is too short',
    )

    expect(api.failStep).toHaveBeenLastCalledWith(
      45,
      expect.any(Number),
      expect.any(Error),
      false,
    )
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
    heygen.getVideo
      .mockResolvedValueOnce({
        videoId: 'video-1',
        status: 'completed',
        videoUrl: 'https://files.heygen.ai/expired.mp4',
      })
      .mockResolvedValueOnce({
        videoId: 'video-1',
        status: 'completed',
        videoUrl: 'https://files.heygen.ai/fresh.mp4',
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
      51,
    )
    expect(heygen.getVideo).toHaveBeenCalledTimes(2)
    expect(api.fetchLocalAsset).toHaveBeenLastCalledWith(
      'https://files.heygen.ai/fresh.mp4',
      expect.objectContaining({
        url: 'https://files.heygen.ai/fresh.mp4',
      }),
    )
    expect(api.completeJob).toHaveBeenCalledWith(51)
  })

  it('preserves durable cancellation instead of converting it to failure', async () => {
    const api = jobApi('digital_human_render', { render_id: 12 })
    api.getJob
      .mockResolvedValueOnce({
        id: 52,
        flow: 'digital_human_render',
        title: 'cancelled render',
        status: 'queued',
        input: { render_id: 12 },
        steps: [],
      })
      .mockResolvedValueOnce({
        id: 52,
        flow: 'digital_human_render',
        title: 'cancelled render',
        status: 'queued',
        input: { render_id: 12 },
        steps: [],
      })
      .mockResolvedValueOnce({
        id: 52,
        flow: 'digital_human_render',
        title: 'cancelled render',
        status: 'cancelled',
        input: { render_id: 12 },
        steps: [],
      })
    api.getRenderContext.mockResolvedValue({
      id: 12,
      project_id: 5,
      version: 2,
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
    const heygen = heygenMock()
    heygen.uploadAsset.mockResolvedValue({ asset_id: 'background-2' })
    heygen.createVideo.mockResolvedValue({
      videoId: 'video-2',
      status: 'waiting',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanRenderJob(52, deps)).rejects.toThrow('任务已取消')

    expect(api.failStep).not.toHaveBeenCalled()
    expect(api.updateRender).toHaveBeenLastCalledWith(
      12,
      expect.objectContaining({ status: 'cancelled' }),
      52,
    )
    expect(api.completeJob).not.toHaveBeenCalled()
  })

  it('does not upload or mark success when cancelled during local save', async () => {
    const api = jobApi('digital_human_render', { render_id: 14 })
    let cancelled = false
    api.getJob.mockImplementation(async () => ({
      id: 54,
      flow: 'digital_human_render',
      title: 'cancel during save',
      status: cancelled ? 'cancelled' : 'queued',
      input: { render_id: 14 },
      steps: [],
    }))
    api.getRenderContext.mockResolvedValue({
      id: 14,
      project_id: 5,
      version: 4,
      status: 'running',
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
      provider_state: {
        environment_asset_id: 'background-4',
        video_id: 'video-4',
      },
      heygen_environment_asset_id: 'background-4',
      heygen_video_id: 'video-4',
    })
    api.fetchLocalAsset.mockImplementation(async () => {
      cancelled = true
      return {
        bytes: new Uint8Array([0, 0, 0, 24]),
        mediaType: 'video/mp4',
        filename: 'result.mp4',
      }
    })
    const heygen = heygenMock()
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-4',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result-4.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanRenderJob(54, deps)).rejects.toThrow(
      '任务已取消',
    )

    expect(api.saveVideoAsset).not.toHaveBeenCalled()
    expect(api.updateRender).toHaveBeenLastCalledWith(
      14,
      expect.objectContaining({ status: 'cancelled' }),
      54,
    )
    expect(api.completeJob).not.toHaveBeenCalled()
  })

  it('removes a local video asset when cancellation lands during upload', async () => {
    const api = jobApi('digital_human_render', { render_id: 15 })
    let cancelled = false
    api.getJob.mockImplementation(async () => ({
      id: 55,
      flow: 'digital_human_render',
      title: 'cancel during upload',
      status: cancelled ? 'cancelled' : 'queued',
      input: { render_id: 15 },
      steps: [],
    }))
    api.getRenderContext.mockResolvedValue({
      id: 15,
      project_id: 5,
      version: 5,
      status: 'running',
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
      provider_state: {
        environment_asset_id: 'background-5',
        video_id: 'video-5',
      },
      heygen_environment_asset_id: 'background-5',
      heygen_video_id: 'video-5',
    })
    api.fetchLocalAsset.mockResolvedValue({
      bytes: new Uint8Array([0, 0, 0, 24]),
      mediaType: 'video/mp4',
      filename: 'result.mp4',
    })
    api.saveVideoAsset.mockImplementation(async () => {
      cancelled = true
      return { id: 90, url: '/api/uploads/orphan.mp4' }
    })
    const heygen = heygenMock()
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-5',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result-5.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanRenderJob(55, deps)).rejects.toThrow(
      '任务已取消',
    )

    expect(api.deleteAsset).toHaveBeenCalledWith(90)
    expect(api.updateRender).toHaveBeenLastCalledWith(
      15,
      expect.objectContaining({ status: 'cancelled' }),
      55,
    )
  })

  it('does not downgrade a locally saved video when job finalization fails', async () => {
    const api = jobApi('digital_human_render', { render_id: 13 })
    api.getRenderContext.mockResolvedValue({
      id: 13,
      project_id: 5,
      version: 3,
      status: 'running',
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
      provider_state: {
        environment_asset_id: 'background-3',
        video_id: 'video-3',
      },
      heygen_environment_asset_id: 'background-3',
      heygen_video_id: 'video-3',
    })
    api.fetchLocalAsset.mockResolvedValue({
      bytes: new Uint8Array([0, 0, 0, 24]),
      mediaType: 'video/mp4',
      filename: 'result.mp4',
    })
    api.saveVideoAsset.mockResolvedValue({
      id: 89,
      url: '/api/uploads/result-3.mp4',
    })
    api.completeJob.mockRejectedValue(new Error('job finalization unavailable'))
    const heygen = heygenMock()
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-3',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result-3.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanRenderJob(53, deps)).rejects.toThrow(
      '任务结果已保存，等待任务状态对账',
    )

    expect(api.updateRender).toHaveBeenLastCalledWith(
      13,
      expect.objectContaining({
        status: 'succeeded',
        video_asset_id: 89,
      }),
      53,
    )
  })

  it('reconciles a completeStep response lost after server commit', async () => {
    const api = jobApi('digital_human_setup', { digital_human_id: 7 })
    let avatarStepCommitted = false
    api.getJob.mockImplementation(async () => ({
      id: 56,
      flow: 'digital_human_setup',
      title: 'lost step response',
      status: 'running',
      input: { digital_human_id: 7 },
      steps: avatarStepCommitted
        ? [{
            id: 1,
            key: 'heygen_avatar',
            attempt: 1,
            status: 'succeeded',
            output: {
              avatar_id: 'avatar-1',
              avatar_group_id: 'group-1',
            },
          }]
        : [],
    }))
    api.completeStep.mockImplementationOnce(async () => {
      avatarStepCommitted = true
      throw new Error('response lost')
    })
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
        voice_id: 'voice-1',
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
    heygen.getVoice.mockResolvedValue({
      voiceId: 'voice-1',
      status: 'complete',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanSetupJob(56, deps)

    expect(api.failStep).not.toHaveBeenCalled()
    expect(api.completeJob).toHaveBeenCalledWith(56)
  })

  it('reconciles terminal render progress when its response is lost', async () => {
    const api = jobApi('digital_human_render', { render_id: 16 })
    const context = {
      id: 16,
      project_id: 5,
      version: 6,
      status: 'running',
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
      provider_state: {
        environment_asset_id: 'background-6',
        video_id: 'video-6',
      },
      heygen_environment_asset_id: 'background-6',
      heygen_video_id: 'video-6',
      video_asset_id: null,
    }
    api.getRenderContext
      .mockResolvedValueOnce(context)
      .mockResolvedValue({
        ...context,
        status: 'succeeded',
        video_asset_id: 91,
      })
    api.fetchLocalAsset.mockResolvedValue({
      bytes: new Uint8Array([0, 0, 0, 24]),
      mediaType: 'video/mp4',
      filename: 'result.mp4',
    })
    api.saveVideoAsset.mockResolvedValue({
      id: 91,
      url: '/api/uploads/result-6.mp4',
    })
    api.updateRender.mockRejectedValueOnce(new Error('response lost'))
    const heygen = heygenMock()
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-6',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result-6.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanRenderJob(57, deps)

    expect(api.updateRender).toHaveBeenCalledTimes(1)
    expect(api.failStep).not.toHaveBeenCalled()
    expect(api.completeJob).toHaveBeenCalledWith(57)
  })

  it('resumes a running save step from an already-succeeded domain result', async () => {
    const api = jobApi('digital_human_render', { render_id: 18 })
    api.getJob.mockResolvedValue({
      id: 59,
      flow: 'digital_human_render',
      title: 'resume running save',
      status: 'running',
      input: { render_id: 18 },
      steps: [
        {
          id: 98,
          key: 'heygen_render',
          attempt: 1,
          status: 'succeeded',
          output: {
            video_id: 'video-8',
            video_url: 'https://files.heygen.ai/expired.mp4',
            environment_asset_id: 'background-8',
          },
        },
        {
          id: 99,
          key: 'save_talking_video',
          attempt: 1,
          status: 'running',
          output: {},
        },
      ],
    })
    api.getRenderContext.mockResolvedValue({
      id: 18,
      project_id: 5,
      version: 8,
      status: 'succeeded',
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
      provider_state: {
        environment_asset_id: 'background-8',
        video_id: 'video-8',
      },
      heygen_environment_asset_id: 'background-8',
      heygen_video_id: 'video-8',
      video_asset_id: 92,
    })
    const deps = {
      api,
      heygen: heygenMock(),
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanRenderJob(59, deps)

    expect(api.startStep).not.toHaveBeenCalled()
    expect(api.saveVideoAsset).not.toHaveBeenCalled()
    expect(api.updateRender).not.toHaveBeenCalled()
    expect(api.completeStep).toHaveBeenCalledWith(
      59,
      99,
      { video_asset_id: 92, url: '' },
    )
    expect(api.completeJob).toHaveBeenCalledWith(59)
  })

  it('never downgrades domain state when terminal progress is ambiguous', async () => {
    const api = jobApi('digital_human_render', { render_id: 19 })
    const context = {
      id: 19,
      project_id: 5,
      version: 9,
      status: 'running',
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
      provider_state: {
        environment_asset_id: 'background-9',
        video_id: 'video-9',
      },
      heygen_environment_asset_id: 'background-9',
      heygen_video_id: 'video-9',
      video_asset_id: null,
    }
    api.getRenderContext
      .mockResolvedValueOnce(context)
      .mockRejectedValueOnce(new Error('reconciliation read unavailable'))
    api.fetchLocalAsset.mockResolvedValue({
      bytes: new Uint8Array([0, 0, 0, 24]),
      mediaType: 'video/mp4',
      filename: 'result.mp4',
    })
    api.saveVideoAsset.mockResolvedValue({
      id: 93,
      url: '/api/uploads/result-9.mp4',
    })
    api.updateRender.mockRejectedValueOnce(new Error('progress response lost'))
    const heygen = heygenMock()
    heygen.getVideo.mockResolvedValue({
      videoId: 'video-9',
      status: 'completed',
      videoUrl: 'https://files.heygen.ai/result-9.mp4',
    })
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await expect(runDigitalHumanRenderJob(60, deps)).rejects.toThrow(
      '成片结果可能已保存，等待任务状态对账',
    )

    expect(api.updateRender).toHaveBeenCalledTimes(1)
    expect(api.failStep).not.toHaveBeenCalled()
  })

  it('composes a look still for ComfyUI roles instead of cloning HeyGen assets', async () => {
    const api = jobApi('digital_human_setup', { digital_human_id: 7 })
    api.getRoleContext.mockResolvedValue({
      id: 7,
      name: '林晓',
      status: 'processing',
      provider: 'comfyui',
      portrait: {
        url: '/api/uploads/portrait.png',
        media_type: 'image/png',
        filename: 'portrait.png',
      },
      voice_sample: null,
      look_asset_id: null,
      provider_state: {},
      heygen_avatar_group_id: '',
      heygen_avatar_id: '',
      heygen_voice_id: '',
    })
    api.composeLook.mockResolvedValue({
      look_asset_id: 44,
      url: '/api/uploads/look.jpg',
    })
    api.updateRole.mockResolvedValue({ status: 'ready', look_asset_id: 44 })
    const heygen = heygenMock()
    const deps = {
      api,
      heygen,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as DigitalHumanJobDeps

    await runDigitalHumanSetupJob(41, deps)

    expect(api.composeLook).toHaveBeenCalledWith(7, 41)
    expect(heygen.uploadAsset).not.toHaveBeenCalled()
    expect(api.updateRole).toHaveBeenCalledWith(7, {
      status: 'ready',
      look_asset_id: 44,
      provider_state: { look_asset_id: 44 },
      error: '',
    }, 41)
  })
})
