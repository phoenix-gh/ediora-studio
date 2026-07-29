import { expect, it, vi } from 'vitest'

import { runContentJob } from '../lib/ai/content-job'
import { runTextVideoMasterJob } from '../lib/ai/text-video-master-job'
import { runTextVideoSceneJob } from '../lib/ai/text-video-scene-job'
import { runTextVideoSpeechJob } from '../lib/ai/text-video-speech-job'
import { runTextVideoSplitJob } from '../lib/ai/text-video-split-job'


const redisConstructor = vi.hoisted(() => vi.fn())

vi.mock('ioredis', () => ({
  default: class ForbiddenImportRedis {
    constructor(...args: unknown[]) {
      redisConstructor(...args)
      throw new Error('content-worker connected to Redis during import')
    }
  },
}))

it('is import-safe and explicitly dispatches every text-video flow', async () => {
  const { resolveContentJobRunner } = await import('./content-worker')

  expect(redisConstructor).not.toHaveBeenCalled()
  expect(resolveContentJobRunner('text_video_split_preview'))
    .toBe(runTextVideoSplitJob)
  expect(resolveContentJobRunner('text_video_speech'))
    .toBe(runTextVideoSpeechJob)
  expect(resolveContentJobRunner('text_video_master_audio'))
    .toBe(runTextVideoMasterJob)
  expect(resolveContentJobRunner('text_video_scene_plan'))
    .toBe(runTextVideoSceneJob)
  expect(resolveContentJobRunner('content'))
    .toBe(runContentJob)
  expect(() => resolveContentJobRunner('text_video_unknown'))
    .toThrow('Unsupported text-video content flow')
})
