// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { XSection } from './XSection'

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

  it('saves only the X collection interval', async () => {
    const settings = makeSettings({
      x_collect_interval_minutes: 15,
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<XSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('新订阅默认采集间隔'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      x_collect_interval_minutes: 30,
    }))
  })
})
