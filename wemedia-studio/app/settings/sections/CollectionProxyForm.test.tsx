// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { CollectionProxyForm } from './CollectionProxyForm'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('CollectionProxyForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves one URL for both collection proxy variables', async () => {
    const saved = makeSettings({
      collection_proxy_url: 'http://127.0.0.1:7890',
      collection_proxy_url_set: true,
      collection_proxy_url_preview: 'http://127.0.0.1:7890',
    })
    vi.mocked(updateSettings).mockResolvedValue(saved)
    render(<CollectionProxyForm settings={makeSettings()} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('代理地址'), {
      target: { value: 'http://127.0.0.1:7890' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存代理' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      collection_proxy_url: 'http://127.0.0.1:7890',
    }))
  })

  it('does not overwrite a credential proxy when the masked input is blank', () => {
    render(<CollectionProxyForm settings={makeSettings({
      collection_proxy_url: '',
      collection_proxy_url_set: true,
      collection_proxy_url_preview: 'http://***@proxy.example.com:7890',
    })} onSaved={vi.fn()} />)

    expect(screen.getByText('http://***@proxy.example.com:7890')).toBeVisible()
    expect(screen.getByRole('button', { name: '保存代理' })).toBeDisabled()
  })

  it('clears the proxy explicitly', async () => {
    vi.mocked(updateSettings).mockResolvedValue(makeSettings())
    render(<CollectionProxyForm settings={makeSettings({
      collection_proxy_url: 'http://127.0.0.1:7890',
      collection_proxy_url_set: true,
      collection_proxy_url_preview: 'http://127.0.0.1:7890',
    })} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '清除代理' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      collection_proxy_url: '',
    }))
  })

  it('explains the environment variables and covered collection sources', () => {
    render(<CollectionProxyForm settings={makeSettings()} onSaved={vi.fn()} />)

    expect(screen.getByText(/HTTP_PROXY/)).toBeVisible()
    expect(screen.getByText(/HTTPS_PROXY/)).toBeVisible()
    for (const source of ['X / feedgrab', 'Reddit', 'YouTube', 'GitHub', '论文']) {
      expect(screen.getByText(new RegExp(source))).toBeVisible()
    }
  })
})
