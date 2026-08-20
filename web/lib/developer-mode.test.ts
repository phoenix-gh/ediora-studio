import { describe, expect, it } from 'vitest'
import { isDeveloperModeEnabled } from './developer-mode'

describe('isDeveloperModeEnabled', () => {
  it('is disabled unless an explicit truthy value is configured', () => {
    expect(isDeveloperModeEnabled('0')).toBe(false)
    expect(isDeveloperModeEnabled('')).toBe(false)
    expect(isDeveloperModeEnabled(undefined)).toBe(false)
  })

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('accepts %s as enabled', value => {
    expect(isDeveloperModeEnabled(value)).toBe(true)
  })
})
