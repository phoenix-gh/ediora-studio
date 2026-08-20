import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDeveloperModeEnabled } from './developer-mode'

describe('isDeveloperModeEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is disabled unless an explicit truthy value is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', '0')
    expect(isDeveloperModeEnabled()).toBe(false)

    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', '')
    expect(isDeveloperModeEnabled()).toBe(false)
  })

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('accepts %s as enabled', value => {
    vi.stubEnv('NEXT_PUBLIC_DEVELOPER_MODE', value)
    expect(isDeveloperModeEnabled()).toBe(true)
  })
})
