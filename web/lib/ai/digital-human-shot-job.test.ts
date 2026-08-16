import { describe, expect, it, vi } from 'vitest'

import {
  resolveWorkerAssetUrl,
  runDigitalHumanShotRenderJob,
  type ShotJobDeps,
} from './digital-human-shot-job'


function jobApi() {
  let stepId = 0
  return {
    getJob: vi.fn().mockResolvedValue({
      id: 1,
      flow: 'digital_human_shot_render',
      title: 'job',
      status: 'queued',
      input: { project_id: 9, shot_id: 'shot-1' },
      steps: [],
    }),
    startStep: vi.fn().mockImplementation(async () => ({ id: ++stepId })),
    completeStep: vi.fn().mockResolvedValue(undefined),
    failStep: vi.fn().mockResolvedValue(undefined),
    completeJob: vi.fn().mockResolvedValue(undefined),
    getShotContext: vi.fn().mockResolvedValue({
      project_id: 9,
      shot: {
        id: 'shot-1',
        duration_sec: 5,
        framing: 'medium',
        spoken_text: '今天只讲一件事',
        motion_prompt: '',
        provider_state: {},
        status: 'queued',
      },
      picture_1: {
        url: '/api/uploads/look.jpg',
        media_type: 'image/jpeg',
        filename: 'look.jpg',
      },
      picture_2: {
        url: '/api/uploads/env.jpg',
        media_type: 'image/jpeg',
        filename: 'env.jpg',
      },
      audio_1: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
    }),
    updateShot: vi.fn().mockResolvedValue(undefined),
    fetchLocalAsset: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg',
      filename: 'look.jpg',
    }),
    saveVideoAsset: vi.fn().mockResolvedValue({ id: 77, url: '/api/uploads/shot.mp4' }),
  }
}


describe('digital-human shot render job', () => {
  it('resolves upload paths against the API base without doubling /api', () => {
    expect(resolveWorkerAssetUrl(
      '/api/uploads/look.jpg',
      'http://127.0.0.1:8000/api',
    )).toBe('http://127.0.0.1:8000/api/uploads/look.jpg')
    expect(resolveWorkerAssetUrl(
      'https://cdn.example/look.jpg',
      'http://127.0.0.1:8000/api',
    )).toBe('https://cdn.example/look.jpg')
  })

  it('uploads the look, queues H3, and saves the clip', async () => {
    const api = jobApi()
    const comfyui = {
      uploadImage: vi.fn()
        .mockResolvedValueOnce({ name: 'look.jpg', subfolder: '', type: 'input' })
        .mockResolvedValueOnce({ name: 'env.jpg', subfolder: '', type: 'input' })
        .mockResolvedValueOnce({ name: 'look.jpg', subfolder: '', type: 'input' }),
      uploadAudio: vi.fn().mockResolvedValue({ name: 'voice.wav', subfolder: '', type: 'input' }),
      queuePrompt: vi.fn().mockResolvedValue('prompt-1'),
      getHistory: vi.fn().mockResolvedValue({
        status: { completed: true },
        outputs: {
          '3': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] },
        },
      }),
      viewFile: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9])),
    }
    const deps = {
      api,
      comfyui,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShotJobDeps

    await runDigitalHumanShotRenderJob(12, deps)

    expect(comfyui.uploadImage).toHaveBeenCalledTimes(3)
    expect(comfyui.uploadAudio).toHaveBeenCalled()
    expect(comfyui.queuePrompt).toHaveBeenCalled()
    const prompt = comfyui.queuePrompt.mock.calls[0]?.[0] as Record<string, { inputs?: Record<string, unknown> }>
    expect(prompt['132']?.inputs?.value).toBe(5)
    expect(prompt['138']?.inputs?.value).toContain('今天只讲一件事')
    expect(prompt['138']?.inputs?.value).toContain('Uses <Audio 1> only as voice timbre.')
    expect(prompt['137']?.inputs?.image).toBe('look.jpg')
    expect(prompt['143']?.inputs?.audio).toBe('voice.wav')
    expect(api.saveVideoAsset).toHaveBeenCalled()
    expect(api.updateShot).toHaveBeenCalledWith(
      9,
      'shot-1',
      expect.objectContaining({
        status: 'succeeded',
        clip_asset_id: 77,
        workflow_version: 'h3-ref2va-v1',
      }),
      12,
    )
    expect(api.updateShot).toHaveBeenCalledWith(
      9,
      'shot-1',
      expect.objectContaining({
        provider_state: expect.objectContaining({
          submitted_prompt: expect.stringContaining('今天只讲一件事'),
        }),
      }),
      12,
    )
    expect(api.completeJob).toHaveBeenCalledWith(12)
  })

  it('uses the previous last frame as the next shot first frame', async () => {
    const api = jobApi()
    api.getShotContext.mockResolvedValue({
      project_id: 9,
      shot: {
        id: 'shot-2',
        duration_sec: 5,
        framing: 'close',
        spoken_text: '下一句',
        motion_prompt: '',
        provider_state: {},
        status: 'queued',
      },
      picture_1: {
        url: '/api/uploads/look.jpg',
        media_type: 'image/jpeg',
        filename: 'look.jpg',
      },
      picture_2: {
        url: '/api/uploads/env.jpg',
        media_type: 'image/jpeg',
        filename: 'env.jpg',
      },
      audio_1: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
      previous_clip: {
        url: '/api/uploads/prev.mp4',
        media_type: 'video/mp4',
        filename: 'prev.mp4',
      },
      needs_previous_clip: true,
    })
    api.extractLastFrame = vi.fn().mockResolvedValue(new Uint8Array([9, 8, 7]))
    const comfyui = {
      uploadImage: vi.fn()
        .mockResolvedValueOnce({ name: 'look.jpg', subfolder: '', type: 'input' })
        .mockResolvedValueOnce({ name: 'env.jpg', subfolder: '', type: 'input' })
        .mockResolvedValueOnce({ name: 'first-frame.jpg', subfolder: '', type: 'input' }),
      uploadAudio: vi.fn().mockResolvedValue({ name: 'voice.wav', subfolder: '', type: 'input' }),
      queuePrompt: vi.fn().mockResolvedValue('prompt-2'),
      getHistory: vi.fn().mockResolvedValue({
        status: { completed: true },
        outputs: {
          '3': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] },
        },
      }),
      viewFile: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9])),
    }
    const deps = {
      api,
      comfyui,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShotJobDeps

    await runDigitalHumanShotRenderJob(13, deps)

    expect(api.extractLastFrame).toHaveBeenCalled()
    expect(comfyui.uploadImage.mock.calls[2]?.[1]).toContain('first-frame-')
    const prompt = comfyui.queuePrompt.mock.calls[0]?.[0] as Record<string, { inputs?: Record<string, unknown> }>
    expect(prompt['138']?.inputs?.value).toContain('<Picture 3>')
    expect(prompt['138']?.inputs?.value).toContain('first frame')
    expect(prompt['142']?.inputs?.image).toBe('first-frame.jpg')
  })

  it('stops the job when the previous clip is missing', async () => {
    const api = jobApi()
    api.getJob.mockResolvedValue({
      id: 14,
      flow: 'digital_human_shot_render',
      title: 'job',
      status: 'queued',
      input: { project_id: 9, shot_id: 'shot-2' },
      steps: [],
    })
    api.getShotContext.mockResolvedValue({
      project_id: 9,
      shot: {
        id: 'shot-2',
        duration_sec: 5,
        framing: 'medium',
        spoken_text: '下一句',
        motion_prompt: '',
        provider_state: {},
        status: 'queued',
      },
      picture_1: {
        url: '/api/uploads/look.jpg',
        media_type: 'image/jpeg',
        filename: 'look.jpg',
      },
      picture_2: {
        url: '/api/uploads/env.jpg',
        media_type: 'image/jpeg',
        filename: 'env.jpg',
      },
      audio_1: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
      previous_clip: null,
      needs_previous_clip: true,
    })
    const comfyui = {
      uploadImage: vi.fn(),
      uploadAudio: vi.fn(),
      queuePrompt: vi.fn(),
      getHistory: vi.fn(),
      viewFile: vi.fn(),
    }
    const deps = {
      api,
      comfyui,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShotJobDeps

    await expect(runDigitalHumanShotRenderJob(14, deps)).rejects.toThrow(
      '上一镜成片不存在，已停止以免画面不连贯',
    )
    expect(comfyui.queuePrompt).not.toHaveBeenCalled()
    expect(api.failStep).toHaveBeenCalledWith(
      14,
      expect.any(Number),
      expect.objectContaining({ name: 'MissingPreviousClipError' }),
      false,
    )
    expect(api.updateShot).toHaveBeenCalledWith(
      9,
      'shot-2',
      expect.objectContaining({
        status: 'failed',
        error: '上一镜成片不存在，已停止以免画面不连贯',
      }),
      14,
    )
  })

  it('queues the shot render_prompt instead of rebuilding a default', async () => {
    const api = jobApi()
    api.getShotContext.mockResolvedValue({
      project_id: 9,
      shot: {
        id: 'shot-1',
        duration_sec: 5,
        framing: 'medium',
        spoken_text: '今天只讲一件事',
        motion_prompt: '',
        render_prompt: 'CUSTOM H3 PROMPT\nHe/she says, "今天只讲一件事"',
        provider_state: {},
        status: 'queued',
      },
      picture_1: {
        url: '/api/uploads/look.jpg',
        media_type: 'image/jpeg',
        filename: 'look.jpg',
      },
      picture_2: {
        url: '/api/uploads/env.jpg',
        media_type: 'image/jpeg',
        filename: 'env.jpg',
      },
      audio_1: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
    })
    const comfyui = {
      uploadImage: vi.fn()
        .mockResolvedValueOnce({ name: 'look.jpg', subfolder: '', type: 'input' })
        .mockResolvedValueOnce({ name: 'env.jpg', subfolder: '', type: 'input' })
        .mockResolvedValueOnce({ name: 'look.jpg', subfolder: '', type: 'input' }),
      uploadAudio: vi.fn().mockResolvedValue({ name: 'voice.wav', subfolder: '', type: 'input' }),
      queuePrompt: vi.fn().mockResolvedValue('prompt-1'),
      getHistory: vi.fn().mockResolvedValue({
        status: { completed: true },
        outputs: {
          '3': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] },
        },
      }),
      viewFile: vi.fn().mockResolvedValue(new Uint8Array([9, 9, 9])),
    }
    const deps = {
      api,
      comfyui,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShotJobDeps

    await runDigitalHumanShotRenderJob(12, deps)

    const prompt = comfyui.queuePrompt.mock.calls[0]?.[0] as Record<string, { inputs?: Record<string, unknown> }>
    expect(prompt['138']?.inputs?.value).toBe(
      'CUSTOM H3 PROMPT\nHe/she says, "今天只讲一件事"',
    )
    expect(api.updateShot).toHaveBeenCalledWith(
      9,
      'shot-1',
      expect.objectContaining({
        render_prompt: 'CUSTOM H3 PROMPT\nHe/she says, "今天只讲一件事"',
        provider_state: expect.objectContaining({
          submitted_prompt: 'CUSTOM H3 PROMPT\nHe/she says, "今天只讲一件事"',
        }),
      }),
      12,
    )
  })

  it('reuses prompt_id and marks OOM as not retryable', async () => {
    const api = jobApi()
    api.getShotContext.mockResolvedValue({
      project_id: 9,
      shot: {
        id: 'shot-1',
        duration_sec: 4,
        framing: 'close',
        spoken_text: '下一句',
        motion_prompt: '',
        provider_state: { prompt_id: 'prompt-old' },
        status: 'running',
      },
      picture_1: {
        url: '/api/uploads/look.jpg',
        media_type: 'image/jpeg',
        filename: 'look.jpg',
      },
      picture_2: {
        url: '/api/uploads/env.jpg',
        media_type: 'image/jpeg',
        filename: 'env.jpg',
      },
      audio_1: {
        url: '/api/uploads/voice.wav',
        media_type: 'audio/wav',
        filename: 'voice.wav',
      },
    })
    const comfyui = {
      uploadImage: vi.fn(),
      uploadAudio: vi.fn(),
      queuePrompt: vi.fn(),
      getHistory: vi.fn().mockRejectedValue(new Error('CUDA out of memory')),
      viewFile: vi.fn(),
    }
    const deps = {
      api,
      comfyui,
      sleep: vi.fn().mockResolvedValue(undefined),
    } as unknown as ShotJobDeps

    await expect(runDigitalHumanShotRenderJob(12, deps)).rejects.toThrow('CUDA')
    expect(comfyui.queuePrompt).not.toHaveBeenCalled()
    expect(api.failStep).toHaveBeenCalledWith(
      12,
      expect.any(Number),
      expect.any(Error),
      false,
    )
  })
})
