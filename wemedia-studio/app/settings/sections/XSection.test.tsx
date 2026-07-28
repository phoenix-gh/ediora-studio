// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { listPublishAccounts, type PublishAccount } from '@/lib/api/publish-accounts'
import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { XSection } from './XSection'

vi.mock('@/lib/api/publish-accounts', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/publish-accounts')>()
  return { ...original, listPublishAccounts: vi.fn() }
})

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('./TelegramSettingsCard', () => ({ TelegramSettingsCard: () => <div>Telegram settings</div> }))
vi.mock('./XCredentialAccountsCard', () => ({ XCredentialAccountsCard: () => <div>X credentials</div> }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('XSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves exactly the X interval, notification flag, and cleared account id', async () => {
    vi.mocked(listPublishAccounts).mockResolvedValue([])
    const settings = makeSettings({
      x_collect_interval_minutes: 15,
      x_notify_enabled: true,
      x_response_account_id: '',
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<XSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('switch', { name: '即时响应总开关' }))
    fireEvent.change(screen.getByLabelText('X 订阅采集间隔'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      x_collect_interval_minutes: 30,
      x_notify_enabled: false,
      x_response_account_id: '',
    }))
  })

  it('preserves a real account id that matches the legacy default sentinel', async () => {
    const collidingAccount: PublishAccount = {
      id: '__default_account__',
      name: '真实默认名账号',
      platform: 'x',
      positioning: '',
      audience: '',
      tone: '',
      topic_focus: [],
      taboo: [],
      word_range: {},
      daily_quota: {},
      image_style: '',
      cover_style: {},
      voice_samples: [],
      style_rules: [],
      app_id: '',
      app_secret: '',
      is_active: true,
      created_at: '2026-07-28T00:00:00Z',
    }
    const settings = makeSettings({ x_response_account_id: '' })
    vi.mocked(listPublishAccounts).mockResolvedValue([collidingAccount])
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<XSection settings={settings} onSaved={vi.fn()} />)
    const user = userEvent.setup()

    await waitFor(() => expect(listPublishAccounts).toHaveBeenCalled())
    await user.click(screen.getByRole('combobox', { name: '建议使用的发布账号画像' }))
    await user.click(await screen.findByRole('option', { name: '真实默认名账号' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      x_response_account_id: '__default_account__',
    })))
  })
})
