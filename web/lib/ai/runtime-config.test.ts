import { describe, expect, it } from 'vitest'

import {
  imageModelConfigFromSettings,
  textModelConfigFromSettings,
} from './runtime-config'

describe('runtime provider configuration', () => {
  it('builds a text model from persisted Settings', () => {
    expect(textModelConfigFromSettings({
      api_key: 'settings-text-key',
      model: 'settings-model',
      base_url: 'https://provider.example/v1',
    })).toEqual({
      apiKey: 'settings-text-key',
      modelName: 'settings-model',
      baseURL: 'https://provider.example/v1',
    })
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
})
