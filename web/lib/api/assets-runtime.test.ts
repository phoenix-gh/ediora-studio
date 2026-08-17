// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'


describe('creative asset URL runtime base', () => {
  afterEach(() => {
    delete process.env.API_URL
    delete process.env.NEXT_PUBLIC_API_URL
    vi.resetModules()
  })

  it('uses the public API origin during server rendering', async () => {
    process.env.API_URL = 'http://api:8000/api'
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8000/api'
    vi.resetModules()

    const { creativeAssetUrl } = await import('./assets')

    expect(creativeAssetUrl('/api/uploads/result.mp4')).toBe(
      'http://localhost:8000/api/uploads/result.mp4',
    )
  })
})
