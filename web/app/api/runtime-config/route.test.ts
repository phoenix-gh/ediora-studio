import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET } from './route'

describe('GET /api/runtime-config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])(
    'enables developer mode from the runtime value %s',
    async value => {
      vi.stubEnv('DEVELOPER_MODE', value)

      const response = await GET()

      await expect(response.json()).resolves.toEqual({ developerMode: true })
      expect(response.headers.get('cache-control')).toBe('no-store')
    },
  )

  it.each(['', '0', 'unexpected'])(
    'fails closed for the runtime value %j',
    async value => {
      vi.stubEnv('DEVELOPER_MODE', value)

      const response = await GET()

      await expect(response.json()).resolves.toEqual({ developerMode: false })
    },
  )
})
