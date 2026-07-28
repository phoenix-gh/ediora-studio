// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { HeyGenSection } from './HeyGenSection'

describe('HeyGenSection', () => {
  afterEach(cleanup)

  it('groups HeyGen configuration and prevents saving a blank key', () => {
    render(<HeyGenSection settings={makeSettings()} onSaved={() => undefined} />)

    expect(screen.getByRole('heading', { level: 2, name: 'HeyGen API' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })
})
