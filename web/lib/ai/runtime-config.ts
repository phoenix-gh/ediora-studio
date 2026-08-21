import { createOpenAI } from '@ai-sdk/openai'

import type { LLMAdapterProtocol } from '@/lib/api/settings'

export type TextModelSettings = {
  adapter_id?: string
  protocol?: LLMAdapterProtocol
  api_key?: string
  model?: string
  base_url?: string
  image_response_format?: 'url' | 'base64'
  headers?: Record<string, string>
}

export type ImageModelSettings = TextModelSettings

export type ImageResponseFormat = 'url' | 'base64'

export type TextModelConfig = {
  apiKey: string
  modelName: string
  baseURL?: string
  headers: Record<string, string>
  protocol: LLMAdapterProtocol
}

export type ImageModelConfig = TextModelConfig & {
  responseFormat: ImageResponseFormat
}

export function textModelConfigFromSettings(
  settings: TextModelSettings,
): TextModelConfig {
  const apiKey = settings.api_key?.trim() ?? ''
  if (!apiKey) throw new Error('请先在设置中配置文本模型 API Key')
  return {
    apiKey,
    modelName: settings.model?.trim() || 'gpt-4o-mini',
    baseURL: settings.base_url?.trim() || undefined,
    headers: settings.headers ?? {},
    protocol: settings.protocol === 'openai-responses' ? 'openai-responses' : 'openai',
  }
}

export function imageModelConfigFromSettings(
  settings: ImageModelSettings,
): ImageModelConfig {
  const apiKey = settings.api_key?.trim() ?? ''
  if (!apiKey) throw new Error('请先在设置中配置图片模型 API Key')
  return {
    apiKey,
    modelName: settings.model?.trim() || 'gpt-image-1',
    baseURL: settings.base_url?.trim() || undefined,
    headers: settings.headers ?? {},
    protocol: settings.protocol === 'openai-responses' ? 'openai-responses' : 'openai',
    responseFormat: settings.image_response_format === 'url' ? 'url' : 'base64',
  }
}

export function openaiProviderFromConfig(config: Pick<
  TextModelConfig,
  'apiKey' | 'baseURL' | 'headers'
>) {
  return createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: config.headers,
  })
}

export function textModelForProvider<T>(
  provider: {
    chat: (modelName: string) => T
    responses: (modelName: string) => T
  },
  modelName: string,
  protocol: LLMAdapterProtocol = 'openai',
): T {
  return protocol === 'openai-responses'
    ? provider.responses(modelName)
    : provider.chat(modelName)
}

export function textModelFromConfig(config: TextModelConfig) {
  return textModelForProvider(
    openaiProviderFromConfig(config),
    config.modelName,
    config.protocol,
  )
}
