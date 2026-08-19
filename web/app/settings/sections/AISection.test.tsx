// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchProviderModels,
  testLLM,
  testLLMAdapter,
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
    testLLMAdapter: vi.fn(),
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

const adapterSettings = makeSettings({
  llm_adapters: [
    {
      id: 'chat-main',
      name: '主文本',
      protocol: 'openai',
      endpoint: 'https://chat.example/v1',
      model: 'chat-model',
      supports_text: true,
      supports_image: false,
      image_response_format: 'base64',
      api_key_set: true,
      api_key_preview: '…1234',
    },
    {
      id: 'filter-image',
      name: '筛选图片',
      protocol: 'openai',
      endpoint: 'https://image.example/v1',
      model: 'dall-e-3',
      supports_text: true,
      supports_image: true,
      image_response_format: 'url',
      api_key_set: true,
      api_key_preview: '…5678',
    },
  ],
  llm_text_default_adapter_id: 'chat-main',
  llm_image_default_adapter_id: 'filter-image',
  llm_information_filtering_adapter_id: 'filter-image',
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
      prompt_generation_history_limit: 3,
    }))
  })

  it('saves the prompt generation history limit with the AI settings', async () => {
    vi.mocked(updateSettings).mockResolvedValue(settings)
    render(<AISection settings={settings} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('提示词生成历史'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ prompt_generation_history_limit: 10 }),
    ))
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
      prompt_generation_history_limit: 3,
    }))
  })

  it('saves multiple adapters and independent information filtering selection', async () => {
    vi.mocked(updateSettings).mockResolvedValue(adapterSettings)
    render(<AISection settings={adapterSettings} onSaved={vi.fn()} />)

    expect(screen.getByLabelText('文字默认 Adapter')).toHaveValue('chat-main')
    expect(screen.getByLabelText('图片默认 Adapter')).toHaveValue('filter-image')
    expect(screen.getByLabelText('信息筛选 Adapter')).toHaveValue('filter-image')
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm_text_default_adapter_id: 'chat-main',
      llm_image_default_adapter_id: 'filter-image',
      llm_information_filtering_adapter_id: 'filter-image',
      llm_adapters: expect.arrayContaining([
        expect.objectContaining({ id: 'chat-main', supports_text: true }),
        expect.objectContaining({
          id: 'filter-image',
          supports_image: true,
          image_response_format: 'url',
        }),
      ]),
    })))
  })

  it('shows compact adapter cards and keeps endpoint details inside the editor dialog', async () => {
    render(<AISection settings={adapterSettings} onSaved={vi.fn()} />)

    const card = screen.getByTestId('llm-adapter-card-chat-main')
    expect(card).toHaveTextContent('主文本')
    expect(card).toHaveTextContent('chat-model')
    expect(card).toHaveTextContent('文本')
    expect(card).not.toHaveTextContent('https://chat.example/v1')
    expect(screen.queryByDisplayValue('https://chat.example/v1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑 Adapter 主文本' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('编辑 Adapter')
    expect(within(dialog).getByDisplayValue('https://chat.example/v1')).toBeVisible()
  })

  it('discards adapter edits when the editor dialog is cancelled', async () => {
    render(<AISection settings={adapterSettings} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '编辑 Adapter 主文本' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('模型'), { target: { value: 'draft-model' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('llm-adapter-card-chat-main')).toHaveTextContent('chat-model')
    expect(screen.getByTestId('llm-adapter-card-chat-main')).not.toHaveTextContent('draft-model')
  })

  it('adds a new adapter to the overview only after the editor dialog is saved', async () => {
    render(<AISection settings={settings} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '添加 Adapter' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: '保存 Adapter' })).toBeVisible()
    expect(screen.queryByText('新接口')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Adapter 名称'), { target: { value: '新接口' } })
    fireEvent.change(within(dialog).getByLabelText('模型'), { target: { value: 'new-model' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存 Adapter' }))

    await waitFor(() => {
      const [card] = screen.getAllByTestId(/^llm-adapter-card-/)
      expect(card).toHaveTextContent('新接口')
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('tests an individual adapter with its current draft values', async () => {
    vi.mocked(testLLMAdapter).mockResolvedValue({ ok: true, response: '连接成功' })
    render(<AISection settings={adapterSettings} onSaved={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '编辑 Adapter 主文本' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('模型'), { target: { value: 'draft-model' } })
    fireEvent.change(within(dialog).getByLabelText('API Key'), { target: { value: 'draft-secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '测试连接' }))

    await waitFor(() => expect(testLLMAdapter).toHaveBeenCalledWith({
      adapter: expect.objectContaining({
        id: 'chat-main',
        model: 'draft-model',
        api_key: 'draft-secret',
      }),
    }))
    expect(within(dialog).getByText(/连接成功/)).toBeVisible()
  })

  it('keeps adapter API keys write-only and exposes an explicit clear action in the editor', async () => {
    render(<AISection settings={adapterSettings} onSaved={vi.fn()} />)

    expect(screen.queryByDisplayValue('secret')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '编辑 Adapter 主文本' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/…1234/)).toBeVisible()
    expect(within(dialog).queryByDisplayValue('secret')).toBeNull()
    expect(within(dialog).getByRole('button', { name: /清除 API Key/ })).toBeVisible()
  })

  it('preserves the crypto receiver when creating an Adapter id', () => {
    const cryptoStub = {
      randomUUID(this: unknown) {
        if (this !== globalThis.crypto) throw new TypeError('Illegal invocation')
        return 'adapter-generated'
      },
    }
    vi.stubGlobal('crypto', cryptoStub)

    try {
      render(<AISection settings={settings} onSaved={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: '添加 Adapter' }))

      expect(screen.getByTestId('llm-adapter-adapter-generated')).toBeVisible()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
