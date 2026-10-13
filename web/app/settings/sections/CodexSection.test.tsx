// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHAT_MODEL_SELECTION_STORAGE_KEY } from '@/lib/ai/chat-model-catalog'
import { makeSettings } from '@/lib/api/settings-test-fixtures'
import { updateSettings } from '@/lib/api/settings'

import { CodexSection } from './CodexSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    updateSettings: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const catalog = {
  models: [
    {
      id: 'gpt-fast',
      model: 'gpt-fast',
      displayName: '快速模型',
      isDefault: true,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
      ],
    },
  ],
}

describe('CodexSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('selects a catalog model, accepts a custom id, and saves it for the assistant', async () => {
    const values = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
        removeItem: (key: string) => { values.delete(key) },
        clear: () => { values.clear() },
      },
    })
    values.set(CHAT_MODEL_SELECTION_STORAGE_KEY, JSON.stringify({
      model: 'gpt-fast',
      reasoningEffort: 'low',
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })))
    const saved = makeSettings({
      codex_model: 'proxy/custom-model',
      codex_reasoning_effort: 'high',
    })
    vi.mocked(updateSettings).mockResolvedValue(saved)
    const onSaved = vi.fn()
    render(<CodexSection settings={makeSettings()} onSaved={onSaved} />)

    const select = screen.getByRole('combobox', { name: '模型' })
    await waitFor(() => expect(screen.getByRole('option', { name: '快速模型' })).toBeInTheDocument())
    fireEvent.change(select, { target: { value: 'gpt-fast' } })
    expect(screen.getByRole('textbox', { name: '自定义模型' })).toHaveValue('gpt-fast')

    fireEvent.change(select, { target: { value: '__custom__' } })
    fireEvent.change(screen.getByRole('textbox', { name: '自定义模型' }), {
      target: { value: 'proxy/custom-model' },
    })
    expect(select).toHaveValue('__custom__')
    fireEvent.change(screen.getByRole('combobox', { name: '推理强度' }), {
      target: { value: 'high' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      codex_model: 'proxy/custom-model',
      codex_reasoning_effort: 'high',
    }))
    expect(onSaved).toHaveBeenCalledWith(saved)
    expect(JSON.parse(values.get(CHAT_MODEL_SELECTION_STORAGE_KEY) ?? '')).toEqual({
      model: 'proxy/custom-model',
      reasoningEffort: 'high',
    })
  })

  it('rejects a blank model before saving', async () => {
    render(<CodexSection settings={makeSettings()} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: '自定义模型' }), {
      target: { value: '  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(updateSettings).not.toHaveBeenCalled()
  })
})
