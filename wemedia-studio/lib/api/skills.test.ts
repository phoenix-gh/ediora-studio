import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchSkills } from './skills'

describe('skill management client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('calls the Next same-origin Skill route instead of the backend API base', async () => {
    const response = new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    await fetchSkills()

    expect(fetchMock).toHaveBeenCalledWith('/api/skills', expect.objectContaining({ cache: 'no-store' }))
  })
})
