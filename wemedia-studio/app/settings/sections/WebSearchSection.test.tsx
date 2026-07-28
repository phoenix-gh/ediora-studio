// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { WebSearchSection } from './WebSearchSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('WebSearchSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves exactly one trimmed and clamped SearXNG provider', async () => {
    const settings = makeSettings({
      web_search_providers: [{
        key: 'searxng',
        enabled: false,
        base_url: '',
        timeout_seconds: 12,
      }],
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<WebSearchSection settings={settings} onSaved={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 2, name: 'SearXNG' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '启用 SearXNG' }))
    fireEvent.change(screen.getByLabelText('SearXNG Base URL'), {
      target: { value: '  http://searxng:8080  ' },
    })
    fireEvent.change(screen.getByLabelText('超时（秒）'), { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Web 搜索设置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      web_search_providers: [{
        key: 'searxng',
        enabled: true,
        base_url: 'http://searxng:8080',
        timeout_seconds: 30,
      }],
    }))
  })
})
