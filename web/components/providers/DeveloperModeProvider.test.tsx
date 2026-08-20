// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DeveloperModeProvider,
  useDeveloperMode,
} from './DeveloperModeProvider'

function Probe() {
  return <span>{useDeveloperMode() ? 'enabled' : 'disabled'}</span>
}

describe('DeveloperModeProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes the runtime configuration to client consumers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ developerMode: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <DeveloperModeProvider>
        <Probe />
      </DeveloperModeProvider>,
    )

    expect(screen.getByText('disabled')).toBeInTheDocument()
    expect(await screen.findByText('enabled')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/runtime-config', {
      cache: 'no-store',
    })
  })

  it('stays disabled when runtime configuration cannot be loaded', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <DeveloperModeProvider>
        <Probe />
      </DeveloperModeProvider>,
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByText('disabled')).toBeInTheDocument()
  })
})
