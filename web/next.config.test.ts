// @vitest-environment node

import { describe, expect, it } from 'vitest'
import nextConfig from './next.config'

describe('Next runtime API proxy', () => {
  it('routes the browser proxy to the Compose-internal API base', async () => {
    const rewrites = await nextConfig.rewrites?.()

    expect(rewrites).toEqual([
      {
        source: '/_ediora-api/:path*',
        destination: 'http://api:8000/api/:path*',
      },
    ])
  })
})
