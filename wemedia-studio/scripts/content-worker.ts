import Redis from 'ioredis'

import { runContentJob } from '../lib/ai/content-job'

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
      await runContentJob(jobId)
    } catch (error) {
      console.error(`content job ${jobId} failed`, error)
    }
  }
}

void run()
