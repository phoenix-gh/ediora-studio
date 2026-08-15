// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { WebFetchSection } from './WebFetchSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('WebFetchSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('preserves provider fields while saving the user-selected order', async () => {
    const settings = makeSettings({
      web_fetch_providers: [
        { key: 'direct', enabled: true, base_url: '', timeout_seconds: 12 },
        { key: 'jina_reader', enabled: true, base_url: 'https://r.jina.ai', timeout_seconds: 20 },
        { key: 'camofox', enabled: true, base_url: '', timeout_seconds: 30 },
      ],
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<WebFetchSection settings={settings} onSaved={vi.fn()} />)

    expect(screen.getAllByRole('switch')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '降低 直接抓取 优先级' }))
    fireEvent.click(screen.getByRole('button', { name: '保存网页抓取设置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      web_fetch_providers: [
        { key: 'jina_reader', enabled: true, base_url: 'https://r.jina.ai', timeout_seconds: 20 },
        { key: 'direct', enabled: true, base_url: '', timeout_seconds: 12 },
        { key: 'camofox', enabled: true, base_url: '', timeout_seconds: 30 },
      ],
    }))
  })
})
