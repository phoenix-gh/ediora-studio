// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { SpeechSection } from './SpeechSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('SpeechSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows write-only speech configuration without invoking paid TTS', () => {
    const settings = makeSettings({
      speech_api_key_set: true,
      speech_api_key_preview: '…-key',
    })
    render(<SpeechSection settings={settings} onSaved={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 2, name: '语音合成' })).toBeVisible()
    expect(screen.getByText(
      '当前首个适配器使用 MiMo V2.5 TTS。音色克隆不在本阶段范围内。',
    )).toBeVisible()
    expect(screen.getByLabelText('模型')).toHaveValue('mimo-v2.5-tts')
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.xiaomimimo.com/v1')
    expect(screen.getByLabelText('默认音色')).toHaveValue('mimo_default')
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password')
    expect(screen.queryByDisplayValue('secret-key')).not.toBeInTheDocument()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('preserves a blank key while saving ordinary speech settings', async () => {
    const settings = makeSettings({ speech_api_key_set: true })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<SpeechSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('默认音色'), {
      target: { value: 'narrator_voice' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存语音配置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      speech_provider: 'mimo',
      speech_model: 'mimo-v2.5-tts',
      speech_base_url: 'https://api.xiaomimimo.com/v1',
      speech_api_key: undefined,
      speech_default_voice: 'narrator_voice',
    }))
  })

  it('replaces or explicitly clears the stored API key', async () => {
    const settings = makeSettings({
      speech_api_key_set: true,
      speech_api_key_preview: '…-key',
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<SpeechSection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'new-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存语音配置' }))
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ speech_api_key: 'new-secret' }),
    ))

    fireEvent.click(screen.getByRole('button', { name: '清除密钥' }))
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        speech_api_key: undefined,
        speech_clear_api_key: true,
      }),
    ))
  })
})
