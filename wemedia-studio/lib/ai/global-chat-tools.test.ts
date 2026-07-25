import { afterEach, describe, expect, it, vi } from 'vitest'

import { createImageJob, imageGenerationInputSchema, requiresToolApproval } from './global-chat-tools'

describe('global Chat tool policy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requires approval for MCP tools with a sensitive action verb', () => {
    expect(requiresToolApproval('update_draft')).toBe(true)
    expect(requiresToolApproval('upload_image_from_url')).toBe(true)
    expect(requiresToolApproval('search_ref_materials')).toBe(false)
    expect(requiresToolApproval('list_publish_accounts')).toBe(false)
  })

  it('does not require approval to create a durable image-generation job', () => {
    expect(requiresToolApproval('generateImage')).toBe(false)
  })

  it('accepts only a free-form image prompt', () => {
    expect(imageGenerationInputSchema.safeParse({ prompt: 'x'.repeat(4_000) }).success).toBe(true)
    expect(imageGenerationInputSchema.safeParse({ kind: 'cover', note: 'x' }).success).toBe(false)
  })

  it('creates an independent image job without a draft or image category', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 51, flow: 'standalone_image', status: 'queued' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createImageJob({ apiBase: 'http://localhost:8000/api', prompt: 'minimal editorial cover' }))
      .resolves.toEqual({ jobId: 51, flow: 'standalone_image', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/api/jobs', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"prompt":"minimal editorial cover"'),
    }))
  })

  it('uses the same independent image job for every prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 52, flow: 'standalone_image', status: 'queued' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createImageJob({ apiBase: 'http://localhost:8000/api', prompt: '一张极简风格的月球基地插画' }))
      .resolves.toEqual({ jobId: 52, flow: 'standalone_image', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/api/jobs', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"prompt":"一张极简风格的月球基地插画"'),
    }))
  })
})
