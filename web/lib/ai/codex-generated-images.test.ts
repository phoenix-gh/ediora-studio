import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  codexGeneratedImagePaths,
  codexImageMessageParts,
  publishCodexGeneratedImages,
} from './codex-generated-images'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('codexGeneratedImagePaths', () => {
  it('keeps completed image files and skips the inline bitmap', () => {
    expect(codexGeneratedImagePaths([
      {
        type: 'imageGeneration',
        status: 'completed',
        savedPath: '/images/portrait.png',
        result: 'a'.repeat(5000),
      },
      {
        type: 'Extension',
        kind: 'image_gen.generation',
        status: 'failed',
        savedPath: '/images/failed.png',
        failure: { message: 'no' },
      },
      { type: 'agentMessage', text: 'done' },
    ])).toEqual(['/images/portrait.png'])
  })
})

describe('publishCodexGeneratedImages', () => {
  it('copies only images inside the Codex thread directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codex-images-'))
    const uploads = await mkdtemp(path.join(tmpdir(), 'codex-uploads-'))
    const threadId = 'thread-1'
    await mkdir(path.join(root, threadId), { recursive: true })
    await writeFile(path.join(root, threadId, 'exec-1.png'), png)
    await writeFile(path.join(root, 'outside.png'), png)
    const outside = path.join(root, '..', 'escape.png')
    await writeFile(outside, png)
    await symlink(outside, path.join(root, threadId, 'linked.png'))

    const published = await publishCodexGeneratedImages({
      threadId,
      items: [
        { type: 'imageGeneration', status: 'completed', savedPath: path.join(root, threadId, 'exec-1.png') },
        { type: 'imageGeneration', status: 'completed', savedPath: path.join(root, 'outside.png') },
        { type: 'imageGeneration', status: 'completed', savedPath: path.join(root, threadId, 'linked.png') },
        { type: 'imageGeneration', status: 'completed', savedPath: outside },
      ],
    }, { uploadsDir: uploads, generatedRoot: root })

    expect(published).toHaveLength(2)
    expect(published.every(image => /^\/api\/uploads\/[a-f0-9]+\.png$/.test(image.url))).toBe(true)
    expect(codexImageMessageParts(published).map(part => part.output.asset_url)).toEqual(published.map(image => image.url))
  })
})
