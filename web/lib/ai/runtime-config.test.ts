import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  createDeepSeek: vi.fn(),
  createOpenAI: vi.fn(),
}))

vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: api.createDeepSeek }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: api.createOpenAI }))

import {
  imageModelConfigFromSettings,
  openaiProviderFromConfig,
  textModelFromConfig,
  textModelForProvider,
  textModelConfigFromSettings,
} from './runtime-config'

describe('runtime provider configuration', () => {
  it('routes DeepSeek chat-completion model names through the configured DeepSeek provider', () => {
    const auditedFetch = vi.fn() as unknown as typeof fetch
    api.createOpenAI.mockReturnValue({
      chat: vi.fn(() => 'openai-chat-model'),
      responses: vi.fn(() => 'openai-responses-model'),
    })
    api.createDeepSeek.mockReturnValue({
      chat: vi.fn(() => 'deepseek-chat-model'),
    })

    expect(textModelFromConfig({
      apiKey: 'settings-text-key',
      baseURL: 'https://provider.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
      modelName: 'deepseek-v4-flash',
      protocol: 'openai',
    }, { fetch: auditedFetch })).toBe('deepseek-chat-model')
    expect(api.createDeepSeek).toHaveBeenCalledWith({
      apiKey: 'settings-text-key',
      baseURL: 'https://provider.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
      fetch: auditedFetch,
    })
  })

  it('passes an optional audited fetch to the configured OpenAI provider', () => {
    const auditedFetch = vi.fn()

    openaiProviderFromConfig({
      apiKey: 'settings-text-key',
      baseURL: 'https://provider.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
    }, { fetch: auditedFetch as typeof fetch })

    expect(api.createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'settings-text-key',
      baseURL: 'https://provider.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
      fetch: auditedFetch,
    }))
  })

  it('builds a text model from persisted Settings', () => {
    expect(textModelConfigFromSettings({
      api_key: 'settings-text-key',
      model: 'settings-model',
      base_url: 'https://provider.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
    })).toEqual({
      apiKey: 'settings-text-key',
      modelName: 'settings-model',
      baseURL: 'https://provider.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
      protocol: 'openai',
    })
  })

  it('preserves the OpenAI Responses protocol and selects its provider model', () => {
    const provider = {
      chat: vi.fn(() => 'chat-model'),
      responses: vi.fn(() => 'responses-model'),
    }

    expect(textModelConfigFromSettings({
      api_key: 'settings-text-key',
      protocol: 'openai-responses',
      model: 'settings-model',
    })).toEqual({
      apiKey: 'settings-text-key',
      modelName: 'settings-model',
      baseURL: undefined,
      headers: {},
      protocol: 'openai-responses',
    })
    expect(textModelForProvider(provider, 'settings-model', 'openai-responses'))
      .toBe('responses-model')
    expect(provider.responses).toHaveBeenCalledWith('settings-model')
    expect(provider.chat).not.toHaveBeenCalled()
  })

  it('rejects an empty text Settings key instead of reading the environment', () => {
    expect(() => textModelConfigFromSettings({
      api_key: '',
      model: '',
      base_url: '',
    })).toThrow('请先在设置中配置文本模型 API Key')
  })

  it('rejects an empty image Settings key instead of reading the environment', () => {
    expect(() => imageModelConfigFromSettings({
      api_key: '',
      model: '',
      base_url: '',
    })).toThrow('请先在设置中配置图片模型 API Key')
  })

  it('maps image response format from the selected runtime adapter', () => {
    expect(imageModelConfigFromSettings({
      adapter_id: 'images',
      api_key: 'sk-image',
      model: 'dall-e-3',
      base_url: 'https://images.example/v1',
      image_response_format: 'url',
      headers: { 'X-Tenant': 'tenant-a' },
    })).toEqual({
      apiKey: 'sk-image',
      modelName: 'dall-e-3',
      baseURL: 'https://images.example/v1',
      headers: { 'X-Tenant': 'tenant-a' },
      protocol: 'openai',
      responseFormat: 'url',
    })
  })

  it('defaults missing legacy image response format to base64', () => {
    expect(imageModelConfigFromSettings({
      api_key: 'sk-image',
      model: 'gpt-image-1',
    })).toEqual({
      apiKey: 'sk-image',
      modelName: 'gpt-image-1',
      baseURL: undefined,
      headers: {},
      protocol: 'openai',
      responseFormat: 'base64',
    })
  })
})
