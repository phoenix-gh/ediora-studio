// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearTelegramSettings,
  testTelegramSettings,
  updateSettings,
} from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { TelegramSettingsCard } from './TelegramSettingsCard'

const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn(),
}))

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    updateSettings: vi.fn(),
    testTelegramSettings: vi.fn(),
    clearTelegramSettings: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: toastError,
  },
}))

const emptySettings = makeSettings()
const configuredSettings = makeSettings({
  telegram_bot_token_set: true,
  telegram_bot_token_preview: '…cret',
  telegram_chat_id: '-100123',
  telegram_test_status: 'success',
  telegram_last_tested_at: '2026-07-25T13:06:07Z',
  telegram_last_test_error: '',
})

describe('TelegramSettingsCard', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves a write-only token and clears the input after success', async () => {
    vi.mocked(updateSettings).mockResolvedValue(configuredSettings)
    const onSaved = vi.fn()
    render(<TelegramSettingsCard settings={emptySettings} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('Telegram Bot Token'), { target: { value: '123:secret' } })
    fireEvent.change(screen.getByLabelText('Telegram Chat ID'), { target: { value: '-100123' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Telegram 配置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      telegram_bot_token: '123:secret',
      telegram_chat_id: '-100123',
    }))
    await waitFor(() => expect((screen.getByLabelText('Telegram Bot Token') as HTMLInputElement).value).toBe(''))
    expect(onSaved).toHaveBeenCalledWith(configuredSettings)
    expect(screen.getByText('Token 已配置 …cret')).not.toBeNull()
  })

  it('preserves the saved token when the token input is blank', async () => {
    const updated = { ...configuredSettings, telegram_chat_id: '-100999' }
    vi.mocked(updateSettings).mockResolvedValue(updated)
    render(<TelegramSettingsCard settings={configuredSettings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Telegram Chat ID'), { target: { value: '-100999' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Telegram 配置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      telegram_chat_id: '-100999',
    }))
  })

  it('does not test unsaved form changes and sends no request body', () => {
    render(<TelegramSettingsCard settings={configuredSettings} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Telegram Chat ID'), { target: { value: '-100999' } })

    const testButton = screen.getByRole('button', { name: '发送测试消息' })
    expect((testButton as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('请先保存当前修改')).not.toBeNull()
    fireEvent.click(testButton)
    expect(testTelegramSettings).not.toHaveBeenCalled()
  })

  it('uses returned settings for test progress and Shanghai metadata', async () => {
    let resolveTest: (settings: typeof configuredSettings) => void = () => {}
    const testedSettings = {
      ...configuredSettings,
      telegram_last_tested_at: '2026-07-25T14:06:07Z',
    }
    vi.mocked(testTelegramSettings).mockImplementation(() => new Promise(resolve => { resolveTest = resolve }))
    const onSaved = vi.fn()
    render(<TelegramSettingsCard settings={configuredSettings} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: '发送测试消息' }))
    expect((screen.getByRole('button', { name: '发送中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存 Telegram 配置' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '清除 Telegram 配置' }) as HTMLButtonElement).disabled).toBe(true)

    resolveTest(testedSettings)

    expect(await screen.findByText('上次测试：2026-07-25 22:06:07（Asia/Shanghai）')).not.toBeNull()
    expect(onSaved).toHaveBeenCalledWith(testedSettings)
    expect(testTelegramSettings).toHaveBeenCalledWith()
  })

  it('redacts the current token from save errors and toast output', async () => {
    vi.mocked(updateSettings).mockRejectedValue(new Error('Token 123:secret 无效'))
    render(<TelegramSettingsCard settings={emptySettings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Telegram Bot Token'), { target: { value: ' 123:secret ' } })
    fireEvent.change(screen.getByLabelText('Telegram Chat ID'), { target: { value: '-100123' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Telegram 配置' }))

    expect(await screen.findByText(/保存失败/)).not.toBeNull()
    expect(document.body.textContent).not.toContain('123:secret')
    expect(toastError).toHaveBeenCalledWith(expect.not.stringContaining('123:secret'))
  })

  it('requires explicit confirmation, locks the dialog while clearing, and supports retry', async () => {
    let rejectClear: (error: Error) => void = () => {}
    vi.mocked(clearTelegramSettings)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectClear = reject }))
      .mockResolvedValueOnce(emptySettings)
    const onSaved = vi.fn()
    render(<TelegramSettingsCard settings={configuredSettings} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: '清除 Telegram 配置' }))
    await screen.findByRole('alertdialog', { name: '清除 Telegram 配置' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(clearTelegramSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '清除 Telegram 配置' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认清除' }))
    expect((screen.getByRole('button', { name: '清除中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)

    rejectClear(new Error('暂时无法清除'))
    expect(await screen.findByText('清除失败：暂时无法清除')).not.toBeNull()
    expect(screen.getByRole('alertdialog', { name: '清除 Telegram 配置' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '确认清除' }))
    await waitFor(() => expect(clearTelegramSettings).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onSaved).toHaveBeenCalledWith(emptySettings)
  })

  it('does not overwrite dirty Chat ID input when settings props refresh', () => {
    const { rerender } = render(
      <TelegramSettingsCard settings={configuredSettings} onSaved={vi.fn()} />,
    )
    fireEvent.change(screen.getByLabelText('Telegram Chat ID'), { target: { value: '-100999' } })

    rerender(
      <TelegramSettingsCard
        settings={{ ...configuredSettings, telegram_chat_id: '-100456' }}
        onSaved={vi.fn()}
      />,
    )

    expect((screen.getByLabelText('Telegram Chat ID') as HTMLInputElement).value).toBe('-100999')
  })

  it('syncs clean Chat ID input when settings props refresh', () => {
    const { rerender } = render(
      <TelegramSettingsCard settings={configuredSettings} onSaved={vi.fn()} />,
    )

    rerender(
      <TelegramSettingsCard
        settings={{ ...configuredSettings, telegram_chat_id: '-100456' }}
        onSaved={vi.fn()}
      />,
    )

    expect((screen.getByLabelText('Telegram Chat ID') as HTMLInputElement).value).toBe('-100456')
  })
})
