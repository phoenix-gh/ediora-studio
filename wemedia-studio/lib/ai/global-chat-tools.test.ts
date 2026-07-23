import { describe, expect, it } from 'vitest'

import { requiresToolApproval } from './global-chat-tools'

describe('global Chat tool policy', () => {
  it('requires approval for MCP tools with a sensitive action verb', () => {
    expect(requiresToolApproval('update_draft')).toBe(true)
    expect(requiresToolApproval('upload_image_from_url')).toBe(true)
    expect(requiresToolApproval('search_ref_materials')).toBe(false)
  })

  it('does not require approval to create a durable image-generation job', () => {
    expect(requiresToolApproval('generateImage')).toBe(false)
  })
})
