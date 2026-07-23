import { afterEach, describe, expect, it, vi } from 'vitest'

import { createImageJob, imageGenerationInputSchema, requiresToolApproval } from './global-chat-tools'

describe('global Chat tool policy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requires approval for MCP tools with a sensitive action verb', () => {
    expect(requiresToolApproval('update_draft')).toBe(true)
    expect(requiresToolApproval('upload_image_from_url')).toBe(true)
    expect(requiresToolApproval('search_ref_materials')).toBe(false)
  })

  it('does not require approval to create a durable image-generation job', () => {
    expect(requiresToolApproval('generateImage')).toBe(false)
  })

  it('accepts a complete cover brief without forcing a retry', () => {
    expect(imageGenerationInputSchema.safeParse({ kind: 'cover', note: 'x'.repeat(4_000) }).success).toBe(true)
  })

  it('creates a cover job for the selected draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 51, flow: 'cover', status: 'queued' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createImageJob({ apiBase: 'http://localhost:8000/api', draftId: 12, flow: 'cover', note: 'minimal editorial cover' }))
      .resolves.toEqual({ jobId: 51, flow: 'cover', draftId: 12, status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/api/jobs', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"draft_id":12'),
    }))
  })
})
