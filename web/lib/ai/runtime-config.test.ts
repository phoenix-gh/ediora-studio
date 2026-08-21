import { describe, expect, it, vi } from 'vitest'

import {
  imageModelConfigFromSettings,
  textModelForProvider,
  textModelConfigFromSettings,
} from './runtime-config'

describe('runtime provider configuration', () => {
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
