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
})
