// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchProviderModels,
  testLLM,
  updateSettings,
} from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { AISection } from './AISection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    fetchProviderModels: vi.fn(),
    testLLM: vi.fn(),
    updateSettings: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const settings = makeSettings({
  llm_provider: 'openai',
  llm_model: 'gpt-4.1',
  llm_base_url: 'https://api.openai.com/v1',
  image_base_url: 'https://images.example/v1',
  image_model: 'gpt-image-1',
  providers: [
    {
      key: 'openai',
      label: 'OpenAI',
      base_url: 'https://api.openai.com/v1',
      default_model: 'gpt-4.1',
    },
    {
      key: 'deepseek',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      default_model: 'deepseek-chat',
    },
  ],
})

describe('AISection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('fetches provider models with the current credentials and endpoint', async () => {
    vi.mocked(fetchProviderModels).mockResolvedValue({ ok: true, models: ['gpt-4.1'] })
    render(<AISection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new' } })
    fireEvent.change(screen.getByLabelText('API Endpoint'), {
      target: { value: ' https://gateway.example/v1 ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }))

    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalledWith({
      provider: 'openai',
      api_key: 'sk-new',
      base_url: 'https://gateway.example/v1',
    }))
  })

  it('omits blank write-only secrets while saving every non-secret field', async () => {
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<AISection settings={settings} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      llm_provider: 'openai',
      llm_model: 'gpt-4.1',
      llm_base_url: 'https://api.openai.com/v1',
      image_base_url: 'https://images.example/v1',
      image_model: 'gpt-image-1',
    }))
  })

  it('tests only the currently saved LLM configuration', async () => {
    vi.mocked(testLLM).mockResolvedValue({ ok: true, response: 'ok' })
    render(<AISection settings={{ ...settings, llm_api_key_set: true }} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '连通性测试' }))

    await waitFor(() => expect(testLLM).toHaveBeenCalledWith())
  })
})
