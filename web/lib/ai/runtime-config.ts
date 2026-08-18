export type TextModelSettings = {
  adapter_id?: string
  protocol?: string
  api_key?: string
  model?: string
  base_url?: string
  image_response_format?: 'url' | 'base64'
}

export type ImageModelSettings = TextModelSettings

export type ImageResponseFormat = 'url' | 'base64'

export type TextModelConfig = {
  apiKey: string
  modelName: string
  baseURL?: string
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
    responseFormat: settings.image_response_format === 'url' ? 'url' : 'base64',
  }
}
