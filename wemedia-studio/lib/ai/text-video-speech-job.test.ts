import { describe, expect, it, vi } from 'vitest'

import { runTextVideoSpeechJob } from './text-video-speech-job'


function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 71,
    flow: 'text_video_speech',
    title: 'speech',
    status: 'queued',
    input: {
      project_id: 8,
      segment_id: 'segment-a',
      generation_revision: 2,
      source_hash: 'a'.repeat(64),
    },
    steps: [],
    ...overrides,
  }
}

function deps(jobValue = job()) {
  const api = {
    getJob: vi.fn().mockResolvedValue(jobValue),
    getSpeechContext: vi.fn().mockResolvedValue({
      project_id: 8,
      segment_id: 'segment-a',
      text: '一段口播。',
      generation_revision: 2,
      source_hash: 'a'.repeat(64),
      voice_settings: {
        voice_id: '',
        speed: 1,
        volume: 1,
        pitch: 0,
      },
      runtime: { default_voice: 'mimo_default' },
    }),
    startStep: vi.fn().mockResolvedValue({ id: 91 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockResolvedValue({}),
    saveSpeechResult: vi.fn().mockResolvedValue({
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    }),
    postSpeechFailure: vi.fn().mockResolvedValue({}),
  }
  const speech = {
    generate: vi.fn().mockResolvedValue({
      bytes: new TextEncoder().encode('RIFF-audio'),
      mediaType: 'audio/wav' as const,
      providerRequestId: 'provider-1',
      wordTimings: [{ id: 'w1', text: '一段', start: 0, end: 0.4 }],
    }),
  }
  return { api, speech }
}

describe('text video speech job', () => {
  it('makes one provider call for one segment and uploads the frozen result', async () => {
    const provided = deps()

    const result = await runTextVideoSpeechJob(71, provided)

    expect(provided.speech.generate).toHaveBeenCalledOnce()
    expect(provided.speech.generate).toHaveBeenCalledWith({
      text: '一段口播。',
      voiceId: 'mimo_default',
      speed: 1,
      volume: 1,
      pitch: 0,
      audio: {
        sampleRate: 44100,
        bitrate: 128000,
        format: 'mp3',
        channels: 1,
      },
    })
    expect(provided.api.saveSpeechResult).toHaveBeenCalledWith(
      expect.objectContaining({
        segment_id: 'segment-a',
        generation_revision: 2,
      }),
      expect.objectContaining({
        providerRequestId: 'provider-1',
        mediaType: 'audio/wav',
      }),
      71,
    )
    expect(result).toEqual({
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    })
  })

  it('finalizes a succeeded step without context or another billed call', async () => {
    const output = {
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    }
    const provided = deps(job({
      status: 'running',
      steps: [{
        id: 91,
        key: 'generate_speech',
        attempt: 1,
        status: 'succeeded',
        output,
      }],
    }))

    await expect(runTextVideoSpeechJob(71, provided)).resolves.toEqual(output)

    expect(provided.api.getSpeechContext).not.toHaveBeenCalled()
    expect(provided.speech.generate).not.toHaveBeenCalled()
    expect(provided.api.completeJob).toHaveBeenCalledWith(71)
  })

  it('replays an already-persisted result without another provider call', async () => {
    const provided = deps()
    provided.api.getSpeechContext.mockResolvedValue({
      already_saved: {
        asset_id: 31,
        audio_url: '/api/uploads/audio.mp3',
        duration: 1.25,
      },
    })

    await expect(runTextVideoSpeechJob(71, provided)).resolves.toEqual({
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    })

    expect(provided.speech.generate).not.toHaveBeenCalled()
    expect(provided.api.completeStep).toHaveBeenCalledWith(
      71,
      91,
      expect.objectContaining({ asset_id: 31 }),
    )
  })

  it('reconciles a lost persistence response without another provider call', async () => {
    const provided = deps()
    provided.api.getSpeechContext
      .mockResolvedValueOnce({
        project_id: 8,
        segment_id: 'segment-a',
        text: '一段口播。',
        generation_revision: 2,
        source_hash: 'a'.repeat(64),
        speech_model: 'mimo-v2.5-tts',
        voice_settings: {
          voice_id: 'voice-at-launch',
          speed: 1,
          volume: 1,
          pitch: 0,
        },
        runtime: { default_voice: 'changed-global-voice' },
      })
      .mockResolvedValueOnce({
        already_saved: {
          asset_id: 31,
          audio_url: '/api/uploads/audio.mp3',
          duration: 1.25,
        },
      })
    provided.api.saveSpeechResult.mockRejectedValue(
      new Error('response lost after commit'),
    )

    await expect(runTextVideoSpeechJob(71, provided)).resolves.toEqual({
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    })

    expect(provided.speech.generate).toHaveBeenCalledOnce()
    expect(provided.api.getSpeechContext).toHaveBeenCalledTimes(2)
    expect(provided.api.postSpeechFailure).not.toHaveBeenCalled()
  })

  it('reconciles a lost complete-step response and finalizes the job', async () => {
    const output = {
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    }
    let currentJob = job()
    const provided = deps(currentJob)
    provided.api.getJob.mockImplementation(async () => currentJob)
    provided.api.completeStep.mockImplementation(async () => {
      currentJob = job({
        status: 'running',
        steps: [{
          id: 91,
          key: 'generate_speech',
          attempt: 1,
          status: 'succeeded',
          output,
        }],
      })
      throw new Error('completeStep response lost')
    })

    await expect(runTextVideoSpeechJob(71, provided)).resolves.toEqual(output)

    expect(provided.speech.generate).toHaveBeenCalledOnce()
    expect(provided.api.getJob).toHaveBeenCalledTimes(2)
    expect(provided.api.completeJob).toHaveBeenCalledWith(71)
    expect(provided.api.postSpeechFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })

  it('uses the launch-frozen model and voice after global defaults change', async () => {
    const previousToken = process.env.WMS_WORKER_TOKEN
    process.env.WMS_WORKER_TOKEN = 'worker-token-at-least-32-characters'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const json = (value: unknown) => new Response(
        JSON.stringify(value),
        { headers: { 'Content-Type': 'application/json' } },
      )
      if (url.endsWith('/jobs/71') && !init?.method) {
        return json(job({
          input: {
            project_id: 8,
            segment_id: 'segment-a',
            generation_revision: 2,
            source_hash: 'a'.repeat(64),
            speech_model: 'frozen-model',
          },
        }))
      }
      if (url.endsWith('/steps/generate_speech/start')) {
        return json({ id: 91 })
      }
      if (url.endsWith('/worker-context')) {
        return json({
          project_id: 8,
          segment_id: 'segment-a',
          text: '冻结声音。',
          generation_revision: 2,
          source_hash: 'a'.repeat(64),
          speech_model: 'frozen-model',
          voice_settings: {
            voice_id: 'frozen-voice',
            speed: 1,
            volume: 1,
            pitch: 0,
          },
          runtime: { default_voice: 'changed-voice' },
        })
      }
      if (url.endsWith('/settings/speech-runtime')) {
        return json({
          provider: 'mimo',
          model: 'changed-model',
          base_url: 'https://api.xiaomimimo.com/v1',
          api_key: 'test-key',
          default_voice: 'changed-voice',
        })
      }
      if (url === 'https://api.xiaomimimo.com/v1/chat/completions') {
        return json({
          id: 'provider-1',
          choices: [{
            message: {
              audio: { data: btoa('RIFF-provider-audio') },
            },
          }],
        })
      }
      if (url.endsWith('/worker-result')) {
        return json({
          asset_id: 31,
          audio_url: '/api/uploads/audio.mp3',
          duration: 1.25,
        })
      }
      if (
        url.endsWith('/steps/91/succeed')
        || url.endsWith('/jobs/71/succeed')
      ) return json({})
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await runTextVideoSpeechJob(71)
    } finally {
      vi.unstubAllGlobals()
      if (previousToken === undefined) delete process.env.WMS_WORKER_TOKEN
      else process.env.WMS_WORKER_TOKEN = previousToken
    }

    const providerCall = fetchMock.mock.calls.find(
      ([input]) => String(input).includes('xiaomimimo.com'),
    )
    const body = JSON.parse(String(providerCall?.[1]?.body))
    expect(body.model).toBe('frozen-model')
    expect(body.audio.voice).toBe('frozen-voice')
  })

  it('refetches durable state after a lost complete-step response', async () => {
    const previousToken = process.env.WMS_WORKER_TOKEN
    process.env.WMS_WORKER_TOKEN = 'worker-token-at-least-32-characters'
    const output = {
      asset_id: 31,
      audio_url: '/api/uploads/audio.mp3',
      duration: 1.25,
    }
    let jobReads = 0
    let stepPersisted = false
    let providerCalls = 0
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const json = (value: unknown) => new Response(
        JSON.stringify(value),
        { headers: { 'Content-Type': 'application/json' } },
      )
      if (url.endsWith('/jobs/71') && !init?.method) {
        jobReads += 1
        return json(job(stepPersisted
          ? {
              status: 'running',
              steps: [{
                id: 91,
                key: 'generate_speech',
                attempt: 1,
                status: 'succeeded',
                output,
              }],
            }
          : undefined))
      }
      if (url.endsWith('/steps/generate_speech/start')) {
        return json({ id: 91 })
      }
      if (url.endsWith('/worker-context')) {
        return json({
          project_id: 8,
          segment_id: 'segment-a',
          text: '完成步骤对账。',
          generation_revision: 2,
          source_hash: 'a'.repeat(64),
          speech_model: 'frozen-model',
          voice_settings: {
            voice_id: 'frozen-voice',
            speed: 1,
            volume: 1,
            pitch: 0,
          },
          runtime: { default_voice: 'changed-voice' },
        })
      }
      if (url.endsWith('/settings/speech-runtime')) {
        return json({
          provider: 'mimo',
          model: 'changed-model',
          base_url: 'https://api.xiaomimimo.com/v1',
          api_key: 'test-key',
          default_voice: 'changed-voice',
        })
      }
      if (url === 'https://api.xiaomimimo.com/v1/chat/completions') {
        providerCalls += 1
        return json({
          id: 'provider-1',
          choices: [{
            message: {
              audio: { data: btoa('RIFF-provider-audio') },
            },
          }],
        })
      }
      if (url.endsWith('/worker-result')) return json(output)
      if (url.endsWith('/steps/91/succeed')) {
        stepPersisted = true
        throw new TypeError('complete-step response lost')
      }
      if (url.endsWith('/jobs/71/succeed')) return json({})
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(runTextVideoSpeechJob(71)).resolves.toEqual(output)
    } finally {
      vi.unstubAllGlobals()
      if (previousToken === undefined) delete process.env.WMS_WORKER_TOKEN
      else process.env.WMS_WORKER_TOKEN = previousToken
    }

    expect(jobReads).toBe(2)
    expect(providerCalls).toBe(1)
  })

  it('reports a non-stale provider failure before failing the step', async () => {
    const provided = deps()
    provided.speech.generate.mockRejectedValue(new Error('provider down'))

    await expect(runTextVideoSpeechJob(71, provided))
      .rejects.toThrow('provider down')

    expect(provided.api.postSpeechFailure).toHaveBeenCalledBefore(
      provided.api.failStep,
    )
    expect(provided.api.failStep).toHaveBeenCalledWith(
      71,
      91,
      expect.any(Error),
      true,
    )
  })

  it('still fails the step when domain failure reporting races persistence', async () => {
    const provided = deps()
    provided.speech.generate.mockRejectedValue(new Error('provider down'))
    provided.api.postSpeechFailure.mockRejectedValue(
      new Error('result already persisted'),
    )

    await expect(runTextVideoSpeechJob(71, provided))
      .rejects.toThrow('provider down')

    expect(provided.api.failStep).toHaveBeenCalledWith(
      71,
      91,
      expect.any(Error),
      true,
    )
  })
})
