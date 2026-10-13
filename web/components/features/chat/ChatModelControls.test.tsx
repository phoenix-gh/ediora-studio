// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHAT_MODEL_SELECTION_CHANGED_EVENT,
  CHAT_MODEL_SELECTION_STORAGE_KEY,
  FALLBACK_CHAT_MODELS,
} from '@/lib/ai/chat-model-catalog'

import { ChatModelControls, useChatModelSelection } from './ChatModelControls'

const catalog = {
  models: [
    {
      id: 'gpt-fast',
      model: 'gpt-fast',
      displayName: '快速模型',
      description: 'quick',
      isDefault: true,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'lighter' },
        { reasoningEffort: 'high', description: 'deeper' },
      ],
    },
    {
      id: 'gpt-deep',
      model: 'gpt-deep',
      displayName: '深入模型',
      description: 'deep',
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { reasoningEffort: 'high', description: 'deeper' },
        { reasoningEffort: 'xhigh', description: 'deepest' },
      ],
    },
  ],
}

function Harness() {
  const { models, selection, setModel, setReasoningEffort } = useChatModelSelection()
  const [submitted, setSubmitted] = useState('')
  return (
    <>
      <ChatModelControls
        models={models}
        selection={selection}
        disabled={false}
        onModelChange={setModel}
        onReasoningEffortChange={setReasoningEffort}
      />
      <button type="button" onClick={() => setSubmitted(JSON.stringify(selection))}>send</button>
      <output data-testid="submitted">{submitted}</output>
    </>
  )
}

describe('ChatModelControls', () => {
  beforeEach(() => {
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })))
  })

  it('loads the catalog and keeps a supported effort when the model changes', async () => {
    render(<Harness />)

    const model = await screen.findByRole('combobox', { name: '模型' })
    await waitFor(() => expect(model).toHaveValue(FALLBACK_CHAT_MODELS[0].model))
    expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveValue('medium')
    expect(screen.getByRole('option', { name: '快速模型' })).toBeInTheDocument()

    fireEvent.change(model, { target: { value: 'gpt-deep' } })
    expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveValue('high')
    fireEvent.change(screen.getByRole('combobox', { name: '思考强度' }), { target: { value: 'xhigh' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    expect(screen.getByTestId('submitted')).toHaveTextContent(JSON.stringify({
      model: 'gpt-deep',
      reasoningEffort: 'xhigh',
    }))
    expect(JSON.parse(window.localStorage.getItem(CHAT_MODEL_SELECTION_STORAGE_KEY) ?? '')).toEqual({
      model: 'gpt-deep',
      reasoningEffort: 'xhigh',
    })
    expect(screen.getByRole('option', { name: '很深入' })).toBeInTheDocument()
  })

  it('uses the saved Codex model when this browser has no model yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/settings')) {
        return new Response(JSON.stringify({
          codex_model: 'proxy/saved-model',
          codex_reasoning_effort: 'high',
        }), { status: 200 })
      }
      return new Response(JSON.stringify(catalog), { status: 200 })
    }))
    render(<Harness />)

    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue(
      'proxy/saved-model',
    ))
    expect(screen.getByRole('option', { name: 'proxy/saved-model' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveValue('high')
  })

  it('follows a Codex setting saved while the assistant is open', async () => {
    render(<Harness />)
    await screen.findByRole('option', { name: '快速模型' })

    window.localStorage.setItem(CHAT_MODEL_SELECTION_STORAGE_KEY, JSON.stringify({
      model: 'proxy/saved-model',
      reasoningEffort: 'high',
    }))
    window.dispatchEvent(new Event(CHAT_MODEL_SELECTION_CHANGED_EVENT))

    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue(
      'proxy/saved-model',
    ))
    expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveValue('high')
  })

  it('keeps the default model when the catalog request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<Harness />)

    await waitFor(() => expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue(
      FALLBACK_CHAT_MODELS[0].model,
    ))
    expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveValue('medium')
  })
})
