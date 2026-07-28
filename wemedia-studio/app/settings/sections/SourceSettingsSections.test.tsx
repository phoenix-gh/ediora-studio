// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { ArxivSection } from './ArxivSection'
import { BlogSection } from './BlogSection'
import { CollectSection } from './CollectSection'
import { GitHubSection } from './GitHubSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('source settings sections', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves only the RSSHub field without changing its value', async () => {
    const settings = makeSettings()
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<CollectSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('RSSHub 地址'), {
      target: { value: ' http://rsshub.internal:1200 ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      rsshub_base: ' http://rsshub.internal:1200 ',
    }))
  })

  it('clamps arXiv hours while preserving the category text', async () => {
    const settings = makeSettings()
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<ArxivSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('采集分类'), {
      target: { value: ' cs.AI, cs.CL ' },
    })
    fireEvent.change(screen.getByLabelText('采集间隔'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      arxiv_categories: ' cs.AI, cs.CL ',
      arxiv_collect_interval_hours: 1,
    }))
  })

  it('clamps GitHub intervals and omits a blank saved token', async () => {
    const settings = makeSettings({ github_token_set: true, github_token_preview: 'ghp_…' })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<GitHubSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('采集调度间隔'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Trending 刷新间隔'), { target: { value: '-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      github_interval_minutes: 1,
      github_trending_interval_hours: 1,
    }))
  })

  it('trims the Blog base URL and omits a blank saved token', async () => {
    const settings = makeSettings({ blog_api_token_set: true, blog_api_token_preview: 'blog…' })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<BlogSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('接口地址'), {
      target: { value: ' https://blog.example/ ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      blog_api_base: 'https://blog.example/',
    }))
  })
})
