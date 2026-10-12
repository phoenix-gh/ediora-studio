import { describe, expect, it } from 'vitest'

import { DEFAULT_CODEX_MODEL } from './codex-model'
import {
  ensureAssistantModel,
  ensureNamedModel,
  FALLBACK_CHAT_MODELS,
  parseChatModelCatalog,
  readStoredChatModelSelection,
  reasoningEffortLabel,
  resolveChatModelSelection,
  writeStoredChatModelSelection,
} from './chat-model-catalog'

const catalog = [
  {
    id: 'gpt-fast',
    model: 'gpt-fast',
    displayName: 'Fast',
    description: 'quick',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'lighter' },
      { reasoningEffort: 'medium', description: 'balanced' },
    ],
  },
  {
    id: 'gpt-deep',
    model: 'gpt-deep',
    displayName: 'Deep',
    description: 'deep',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [
      { reasoningEffort: 'high', description: 'deeper' },
      { reasoningEffort: 'xhigh', description: 'deepest' },
    ],
  },
  {
    id: 'hidden-model',
    model: 'hidden-model',
    displayName: 'Hidden',
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
  },
]

describe('chat model catalog', () => {
  it('keeps visible models and their advertised reasoning efforts', () => {
    expect(parseChatModelCatalog({ data: catalog }).map(model => model.model)).toEqual([
      'gpt-fast',
      'gpt-deep',
    ])
    expect(parseChatModelCatalog(catalog)[1]?.supportedReasoningEfforts.map(item => item.reasoningEffort))
      .toEqual(['high', 'xhigh'])
  })

  it('uses the saved model and drops an effort that model does not support', () => {
    const models = parseChatModelCatalog({ models: catalog })
    expect(resolveChatModelSelection(models, { model: 'gpt-fast', reasoningEffort: 'xhigh' })).toEqual({
      model: 'gpt-fast',
      reasoningEffort: 'low',
    })
    expect(resolveChatModelSelection(models, { model: 'missing', reasoningEffort: 'xhigh' })).toEqual({
      model: 'gpt-deep',
      reasoningEffort: 'xhigh',
    })
    expect(resolveChatModelSelection([], null)).toEqual({
      model: FALLBACK_CHAT_MODELS[0].model,
      reasoningEffort: 'medium',
    })
    expect(resolveChatModelSelection(models, {
      model: 'deepseek-flash',
      reasoningEffort: 'medium',
    })).toEqual({
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: 'medium',
    })
    const withAssistant = ensureAssistantModel(models)
    expect(withAssistant.map(item => item.model)).toEqual([
      FALLBACK_CHAT_MODELS[0].model,
      'gpt-fast',
      'gpt-deep',
    ])
    expect(resolveChatModelSelection(withAssistant, null)).toEqual({
      model: FALLBACK_CHAT_MODELS[0].model,
      reasoningEffort: 'medium',
    })
    expect(ensureAssistantModel(withAssistant)).toBe(withAssistant)
    const withCustom = ensureNamedModel(models, 'proxy/my-model')
    expect(withCustom.map(item => item.model)).toContain('proxy/my-model')
    expect(resolveChatModelSelection(withCustom, {
      model: 'proxy/my-model',
      reasoningEffort: 'high',
    })).toEqual({
      model: 'proxy/my-model',
      reasoningEffort: 'high',
    })
    expect(ensureNamedModel(withCustom, 'proxy/my-model')).toBe(withCustom)
    expect(ensureNamedModel(models, 'deepseek-flash').some(item => item.model === 'deepseek-flash')).toBe(false)
    const available = ensureAssistantModel(models)
    expect(ensureNamedModel(available, 'proxy/bad model')).toBe(available)
  })

  it('labels known efforts in Chinese and round-trips the saved selection', () => {
    expect(reasoningEffortLabel('high')).toBe('深入')
    expect(reasoningEffortLabel('custom')).toBe('custom')
    const storage = new Map<string, string>()
    const memory = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    }
    writeStoredChatModelSelection(memory, { model: 'gpt-deep', reasoningEffort: 'high' })
    expect(readStoredChatModelSelection(memory)).toEqual({
      model: 'gpt-deep',
      reasoningEffort: 'high',
    })
    expect(readStoredChatModelSelection({ getItem: () => '{' })).toBeNull()
  })
})
