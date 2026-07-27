// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { YouTubeSection } from './YouTubeSection'


const NETSCAPE_COOKIES = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tyoutube-secret'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('YouTubeSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves pasted cookies and clears the textarea', async () => {
    const configured = { ...makeSettings(), youtube_cookies_set: true }
    vi.mocked(updateSettings).mockResolvedValue(configured)
    const onSaved = vi.fn()
    render(<YouTubeSection settings={makeSettings()} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('cookies.txt'), { target: { value: NETSCAPE_COOKIES } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Cookie' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ youtube_cookies: NETSCAPE_COOKIES }))
    expect((screen.getByLabelText('cookies.txt') as HTMLTextAreaElement).value).toBe('')
    expect(onSaved).toHaveBeenCalledWith(configured)
  })

  it('clears a configured cookie explicitly', async () => {
    const configured = { ...makeSettings(), youtube_cookies_set: true }
    const cleared = { ...makeSettings(), youtube_cookies_set: false }
    vi.mocked(updateSettings).mockResolvedValue(cleared)
    render(<YouTubeSection settings={configured} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '清除 Cookie' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ youtube_cookies: '' }))
  })
})
