import { describe, expect, it, vi } from 'vitest'

import { runDigitalHumanShotRenderJob, type ShotJobDeps } from './digital-human-shot-job'


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
    expect(prompt['138']?.inputs?.value).toContain("Uses <Audio 1>'s voice.")
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
    expect(api.completeJob).toHaveBeenCalledWith(12)
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
