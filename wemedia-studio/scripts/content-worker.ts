import Redis from 'ioredis'

import { runContentJob } from '../lib/ai/content-job'
import {
  runDigitalHumanRenderJob,
  runDigitalHumanSetupJob,
} from '../lib/ai/digital-human-job'
import { getJob } from '../lib/ai/job-client'
import { runXResponseDigestJob, runXResponseJob } from '../lib/ai/x-response-job'

const redisUrl = process.env.WMS_REDIS_URL ?? 'redis://redis:6379/0'
const queueName = process.env.WMS_WORKER_QUEUE ?? 'content-jobs'
const redis = new Redis(redisUrl)

async function run() {
  for (;;) {
    const item = await redis.blpop(queueName, 0)
    if (!item) continue
    const jobId = Number(item[1])
    if (!Number.isSafeInteger(jobId)) continue
    try {
      const job = await getJob(jobId)
      if (job.flow === 'digital_human_setup') {
        await runDigitalHumanSetupJob(jobId)
      } else if (job.flow === 'digital_human_render') {
        await runDigitalHumanRenderJob(jobId)
      } else if (job.flow === 'x_response') await runXResponseJob(jobId)
      else if (job.flow === 'x_response_digest') await runXResponseDigestJob(jobId)
      else await runContentJob(jobId)
    } catch (error) {
      console.error(`content job ${jobId} failed`, error)
    }
  }
}

void run()
