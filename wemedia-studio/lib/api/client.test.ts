// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'


describe('API client runtime base URL', () => {
  afterEach(() => {
    delete process.env.WMS_API_URL
    delete process.env.NEXT_PUBLIC_API_URL
    vi.resetModules()
  })

  it('uses the internal API URL during server rendering', async () => {
    process.env.WMS_API_URL = 'http://api:8000/api'
    process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8000/api'
    vi.resetModules()

    const { API_BASE } = await import('./client')

    expect(API_BASE).toBe('http://api:8000/api')
  })
})
