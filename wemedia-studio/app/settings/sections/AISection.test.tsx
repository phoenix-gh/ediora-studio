// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchProviderModels,
  testLLM,
  updateSettings,
} from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'

import { AISection } from './AISection'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

async function renderWithModelSuggestions() {
  vi.mocked(fetchProviderModels).mockResolvedValue({
    ok: true,
    models: ['gpt-alpha', 'gpt-beta', 'gpt-gamma'],
  })
  render(<AISection settings={{ ...settings, llm_model: '' }} onSaved={vi.fn()} />)
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: '获取可用模型' }))
  await screen.findByText('gpt-alpha')

  const modelInput = screen.getByLabelText('模型')
  await user.click(modelInput)

  return { modelInput, user }
}

describe('AISection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
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

  it('invalidates an older provider request without clearing a newer request loading state', async () => {
    const openAiRequest = deferred<Awaited<ReturnType<typeof fetchProviderModels>>>()
    const deepSeekRequest = deferred<Awaited<ReturnType<typeof fetchProviderModels>>>()
    vi.mocked(fetchProviderModels)
      .mockReturnValueOnce(openAiRequest.promise)
      .mockReturnValueOnce(deepSeekRequest.promise)
    render(<AISection settings={settings} onSaved={vi.fn()} />)
    const user = userEvent.setup()

    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }))
    await waitFor(() => expect(fetchProviderModels).toHaveBeenCalledWith({
      provider: 'openai',
      api_key: undefined,
      base_url: 'https://api.openai.com/v1',
    }))

    await user.click(screen.getByRole('combobox', { name: '供应商' }))
    await user.click(await screen.findByRole('option', { name: 'DeepSeek' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '获取可用模型' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }))
    await waitFor(() => expect(fetchProviderModels).toHaveBeenLastCalledWith({
      provider: 'deepseek',
      api_key: undefined,
      base_url: 'https://api.deepseek.com/v1',
    }))

    await act(async () => {
      openAiRequest.resolve({ ok: true, models: ['stale-openai-model'] })
      await openAiRequest.promise
    })
    expect(screen.getByRole('button', { name: '获取可用模型' })).toBeDisabled()
    expect(screen.queryByText('stale-openai-model')).not.toBeInTheDocument()

    await act(async () => {
      deepSeekRequest.resolve({ ok: true, models: ['deepseek-chat'] })
      await deepSeekRequest.promise
    })
    expect(screen.getByRole('button', { name: '获取可用模型' })).toBeEnabled()
    fireEvent.focus(screen.getByLabelText('模型'))
    expect(await screen.findByText('deepseek-chat')).toBeInTheDocument()
  })

  it('exposes model suggestions as an owned listbox from the model combobox', async () => {
    const { modelInput } = await renderWithModelSuggestions()

    expect(modelInput).toHaveAttribute('role', 'combobox')
    expect(modelInput).toHaveAttribute('aria-autocomplete', 'list')
    expect(modelInput).toHaveAttribute('aria-expanded', 'true')

    const listbox = screen.getByRole('listbox', { name: '可用模型' })
    expect(modelInput).toHaveAttribute('aria-controls', listbox.id)
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('navigates model suggestions with arrow keys and selects the active option with Enter', async () => {
    const { modelInput, user } = await renderWithModelSuggestions()

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}')

    const activeOptionId = modelInput.getAttribute('aria-activedescendant')
    expect(activeOptionId).toBeTruthy()
    expect(document.getElementById(activeOptionId!)).toHaveTextContent('gpt-alpha')
    expect(modelInput).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(modelInput).toHaveValue('gpt-alpha')
    expect(modelInput).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('dismisses model suggestions with Escape without changing the typed value', async () => {
    const { modelInput, user } = await renderWithModelSuggestions()

    await user.keyboard('{ArrowDown}{Escape}')

    expect(modelInput).toHaveValue('')
    expect(modelInput).toHaveFocus()
    expect(modelInput).toHaveAttribute('aria-expanded', 'false')
    expect(modelInput).not.toHaveAttribute('aria-activedescendant')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('still selects a model suggestion with the mouse', async () => {
    const { modelInput, user } = await renderWithModelSuggestions()

    await user.click(screen.getByText('gpt-beta'))

    expect(modelInput).toHaveValue('gpt-beta')
    expect(screen.queryByText('gpt-alpha')).not.toBeInTheDocument()
  })

  it('keeps model suggestions open when the input is refocused before the blur delay expires', async () => {
    const { modelInput } = await renderWithModelSuggestions()
    vi.useFakeTimers()

    fireEvent.blur(modelInput)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    fireEvent.focus(modelInput)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(screen.getByRole('listbox', { name: '可用模型' })).toBeInTheDocument()
    expect(modelInput).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps newly fetched model suggestions open after an earlier blur delay expires', async () => {
    const modelRequest = deferred<Awaited<ReturnType<typeof fetchProviderModels>>>()
    vi.mocked(fetchProviderModels).mockReturnValue(modelRequest.promise)
    render(<AISection settings={{ ...settings, llm_model: '' }} onSaved={vi.fn()} />)
    const modelInput = screen.getByLabelText('模型')
    vi.useFakeTimers()

    fireEvent.focus(modelInput)
    fireEvent.blur(modelInput)
    fireEvent.click(screen.getByRole('button', { name: '获取可用模型' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
      modelRequest.resolve({ ok: true, models: ['newly-fetched-model'] })
      await modelRequest.promise
    })
    expect(screen.getByRole('listbox', { name: '可用模型' })).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(screen.getByRole('listbox', { name: '可用模型' })).toBeInTheDocument()
    expect(modelInput).toHaveAttribute('aria-expanded', 'true')
  })

  it('offers an adjacent image save action that persists the shared AI payload', async () => {
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<AISection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('图像模型'), { target: { value: 'gpt-image-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存图像配置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      llm_provider: 'openai',
      llm_model: 'gpt-4.1',
      llm_base_url: 'https://api.openai.com/v1',
      image_base_url: 'https://images.example/v1',
      image_model: 'gpt-image-2',
    }))
  })
})
