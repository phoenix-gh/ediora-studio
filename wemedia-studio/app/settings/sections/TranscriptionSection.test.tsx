// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getTranscriptionStatus,
  updateSettings,
} from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { TranscriptionSection } from './TranscriptionSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    getTranscriptionStatus: vi.fn(),
    updateSettings: vi.fn(),
    testTranscription: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

describe('TranscriptionSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('clears the secret explicitly and converts minutes to seconds', async () => {
    const settings = makeSettings({
      transcription_provider: 'openai-compatible',
      transcription_api_key_set: true,
      transcription_model: 'whisper-1',
      transcription_base_url: 'https://api.openai.com/v1',
      transcription_max_duration_seconds: 7200,
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<TranscriptionSection settings={settings} onSaved={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 2, name: '语音转写' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('单视频最长分钟数'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: '清除密钥' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      transcription_provider: 'openai-compatible',
      transcription_model: 'whisper-1',
      transcription_base_url: 'https://api.openai.com/v1',
      transcription_api_key: undefined,
      transcription_clear_api_key: true,
      transcription_max_duration_seconds: 2700,
    }))
  })

  it('saves local Whisper without rendering cloud credentials', async () => {
    const settings = makeSettings({
      transcription_provider: 'local-whisper',
      transcription_model: 'Systran/faster-whisper-large-v3',
    })
    vi.mocked(getTranscriptionStatus).mockResolvedValue({
      provider: 'local-whisper',
      status: 'ready',
      model: 'Systran/faster-whisper-large-v3',
      device: 'cuda',
      compute_type: 'int8_float16',
      error: '',
    })
    vi.mocked(updateSettings).mockResolvedValue(settings)

    render(<TranscriptionSection settings={settings} onSaved={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /本地 Whisper/ })).toBeChecked()
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(await screen.findByText('本地转写服务可用')).toBeInTheDocument()
    expect(screen.getByText(/large-v3/)).toBeInTheDocument()
    expect(screen.getByText(/cuda.*int8_float16/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      transcription_provider: 'local-whisper',
      transcription_max_duration_seconds: 7200,
    }))
  })
})
