import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { createHeyGenClient } from '../heygen/client'


function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}


function mediaType(path: string, kind: 'image' | 'audio') {
  const extension = extname(path).toLowerCase()
  if (kind === 'image' && extension === '.png') return 'image/png'
  if (kind === 'image' && ['.jpg', '.jpeg'].includes(extension)) {
    return 'image/jpeg'
  }
  if (kind === 'audio' && extension === '.mp3') return 'audio/mpeg'
  if (kind === 'audio' && extension === '.wav') return 'audio/wav'
  throw new Error(`Unsupported ${kind} file extension: ${extension}`)
}


async function poll<T>(
  load: () => Promise<T>,
  getStatus: (value: T) => string,
  label: string,
) {
  const deadline = Date.now() + 30 * 60 * 1000
  let wait = 2_000
  for (;;) {
    const value = await load()
    const status = getStatus(value).toLowerCase()
    if (['ready', 'complete', 'completed', 'succeeded'].includes(status)) {
      return value
    }
    if (['failed', 'error', 'cancelled'].includes(status)) {
      throw new Error(`${label} failed with status ${status}`)
    }
    if (Date.now() >= deadline) throw new Error(`${label} timed out`)
    await new Promise(resolve => setTimeout(resolve, wait))
    wait = Math.min(Math.round(wait * 1.5), 15_000)
  }
}


async function main() {
  const startedAt = Date.now()
  const apiKey = required('HEYGEN_API_KEY')
  const portraitPath = required('HEYGEN_SMOKE_PORTRAIT')
  const voicePath = required('HEYGEN_SMOKE_VOICE')
  const environmentPath = required('HEYGEN_SMOKE_ENVIRONMENT')
  const runId = randomUUID()
  const client = createHeyGenClient({
    apiKey,
    baseUrl: 'https://api.heygen.com',
  })

  const [portrait, voice, environment] = await Promise.all([
    readFile(portraitPath),
    readFile(voicePath),
    readFile(environmentPath),
  ])
  const uploadStartedAt = Date.now()
  const [portraitAsset, voiceAsset, environmentAsset] = await Promise.all([
    client.uploadAsset(
      new Uint8Array(portrait),
      mediaType(portraitPath, 'image'),
      basename(portraitPath),
      `smoke:${runId}:portrait`,
    ),
    client.uploadAsset(
      new Uint8Array(voice),
      mediaType(voicePath, 'audio'),
      basename(voicePath),
      `smoke:${runId}:voice`,
    ),
    client.uploadAsset(
      new Uint8Array(environment),
      mediaType(environmentPath, 'image'),
      basename(environmentPath),
      `smoke:${runId}:environment`,
    ),
  ])

  const avatarStartedAt = Date.now()
  const avatarCreated = await client.createPhotoAvatar({
    name: `WeMediaStudio smoke ${runId.slice(0, 8)}`,
    assetId: portraitAsset.asset_id,
    idempotencyKey: `smoke:${runId}:avatar`,
  })
  const avatar = await poll(
    () => client.getAvatar(avatarCreated.groupId, avatarCreated.avatarId),
    value => value.status,
    'avatar',
  )

  const voiceStartedAt = Date.now()
  const cloned = await client.cloneVoice({
    name: `WeMediaStudio smoke ${runId.slice(0, 8)}`,
    assetId: voiceAsset.asset_id,
  })
  const clonedVoice = await poll(
    () => client.getVoice(cloned.voiceId),
    value => value.status,
    'voice',
  )

  const videoStartedAt = Date.now()
  const videoCreated = await client.createVideo({
    title: `WeMediaStudio smoke ${runId.slice(0, 8)}`,
    avatarId: avatar.avatarId,
    voiceId: clonedVoice.voiceId,
    script: '大家好，这是一段数字人口播功能的连通性测试。',
    backgroundAssetId: environmentAsset.asset_id,
    idempotencyKey: `smoke:${runId}:video`,
  })
  const video = await poll(
    () => client.getVideo(videoCreated.videoId),
    value => value.status,
    'video',
  )
  if (!video.videoUrl) throw new Error('Completed video has no download URL')
  const response = await fetch(video.videoUrl)
  const contentType = response.headers.get('Content-Type')?.split(';')[0]
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!response.ok || contentType !== 'video/mp4' || !bytes.byteLength) {
    throw new Error(
      `Downloaded result is invalid (${response.status}, ${contentType}, ${bytes.byteLength})`,
    )
  }

  process.stdout.write(`${JSON.stringify({
    asset_ids: {
      portrait: portraitAsset.asset_id,
      voice: voiceAsset.asset_id,
      environment: environmentAsset.asset_id,
    },
    avatar_group_id: avatar.groupId,
    avatar_id: avatar.avatarId,
    voice_id: clonedVoice.voiceId,
    video_id: video.videoId,
    result_bytes: bytes.byteLength,
    timings_ms: {
      uploads: avatarStartedAt - uploadStartedAt,
      avatar: voiceStartedAt - avatarStartedAt,
      voice: videoStartedAt - voiceStartedAt,
      video_and_download: Date.now() - videoStartedAt,
      total: Date.now() - startedAt,
    },
  }, null, 2)}\n`)
}


void main().catch(error => {
  process.stderr.write(
    `HeyGen smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
