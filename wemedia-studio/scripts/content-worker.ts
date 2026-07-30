import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import Redis from 'ioredis'

import { runContentJob } from '../lib/ai/content-job'
import {
  JobFinalizationError,
  runDigitalHumanRenderJob,
  runDigitalHumanSetupJob,
} from '../lib/ai/digital-human-job'
import { getJob } from '../lib/ai/job-client'
import { runContentResponseAnalysisJob } from '../lib/ai/content-response-job'
import { runContentResponseOutputJob } from '../lib/ai/content-response-output-job'
import { runXResponseDigestJob, runXResponseJob } from '../lib/ai/x-response-job'
import { runTopicSourceJob } from '../lib/ai/topic-source-job'
import { runTextVideoSplitJob } from '../lib/ai/text-video-split-job'
import { runTextVideoMasterJob } from '../lib/ai/text-video-master-job'
import { runTextVideoSceneJob } from '../lib/ai/text-video-scene-job'
import { runTextVideoSpeechJob } from '../lib/ai/text-video-speech-job'


export type ContentJobRunner = (jobId: number) => Promise<unknown>

export function resolveContentJobRunner(flow: string): ContentJobRunner {
  if (flow === 'digital_human_setup') return runDigitalHumanSetupJob
  if (flow === 'digital_human_render') return runDigitalHumanRenderJob
  if (flow === 'content_response_analysis') {
    return runContentResponseAnalysisJob
  }
  if (flow === 'content_response_output') return runContentResponseOutputJob
  if (flow === 'x_response') return runXResponseJob
  if (flow === 'x_response_digest') return runXResponseDigestJob
  if (flow === 'topic_source') return runTopicSourceJob
  if (flow === 'text_video_split_preview') return runTextVideoSplitJob
  if (flow === 'text_video_speech') return runTextVideoSpeechJob
  if (flow === 'text_video_master_audio') return runTextVideoMasterJob
  if (flow === 'text_video_scene_plan') return runTextVideoSceneJob
  if (flow.startsWith('text_video_')) {
    throw new Error(`Unsupported text-video content flow: ${flow}`)
  }
  return runContentJob
}

export async function runContentWorker() {
  const redisUrl = process.env.WMS_REDIS_URL ?? 'redis://redis:6379/0'
  const queueName = process.env.WMS_WORKER_QUEUE ?? 'content-jobs'
  const redis = new Redis(redisUrl)
  for (;;) {
    const item = await redis.blpop(queueName, 0)
    if (!item) continue
    const jobId = Number(item[1])
    if (!Number.isSafeInteger(jobId)) continue
    try {
      const job = await getJob(jobId)
      await resolveContentJobRunner(job.flow)(jobId)
    } catch (error) {
      if (error instanceof JobFinalizationError) {
        setTimeout(() => {
          void redis.rpush(queueName, String(jobId))
        }, 5_000)
      }
      console.error(`content job ${jobId} failed`, error)
    }
  }
}

const entryPath = process.argv[1]
if (
  entryPath
  && import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  void runContentWorker()
}
