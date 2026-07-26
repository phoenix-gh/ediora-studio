import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

import {
  buildTalkingScriptPrompt,
  cleanTalkingScript,
  talkingScriptRequestSchema,
} from '@/lib/ai/talking-script'


const apiBase = () => (
  process.env.WMS_API_URL
  ?? process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:8000/api'
).replace(/\/$/, '')


async function configuredModel() {
  try {
    const response = await fetch(`${apiBase()}/settings/ai-runtime`, {
      cache: 'no-store',
    })
    if (response.ok) {
      const settings = await response.json() as {
        api_key: string
        model: string
        base_url: string
      }
      if (settings.api_key) {
        return {
          apiKey: settings.api_key,
          model: settings.model || 'gpt-4o-mini',
          baseURL: settings.base_url || undefined,
        }
      }
    }
  } catch {
    // Environment fallback keeps local development usable.
  }
  const apiKey = process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('请先在设置中配置文本模型 API Key')
  return {
    apiKey,
    model: process.env.WMS_LLM_MODEL ?? 'gpt-4o-mini',
    baseURL: process.env.WMS_LLM_BASE_URL,
  }
}


export async function POST(request: Request) {
  const parsed = talkingScriptRequestSchema.safeParse(await request.json())
  if (!parsed.success) {
    return Response.json({ error: '脚本请求参数无效' }, { status: 400 })
  }
  try {
    const modelConfig = await configuredModel()
    let draft: { title: string; content: string } | undefined
    if (parsed.data.mode === 'convert_draft') {
      const response = await fetch(
        `${apiBase()}/write/drafts/${parsed.data.draftId}`,
        { cache: 'no-store' },
      )
      if (!response.ok) {
        return Response.json({ error: '原稿不存在' }, { status: 404 })
      }
      draft = await response.json() as { title: string; content: string }
      if (draft.content.length > 60_000) {
        return Response.json(
          { error: '原稿超过 60,000 字符限制' },
          { status: 413 },
        )
      }
    }
    const provider = createOpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseURL,
    })
    const result = await generateText({
      model: provider.chat(modelConfig.model),
      prompt: buildTalkingScriptPrompt(parsed.data, draft),
    })
    const script = cleanTalkingScript(result.text)
    if (!script) {
      return Response.json({ error: '模型未返回有效脚本' }, { status: 502 })
    }
    return Response.json({ script })
  } catch (error) {
    const message = error instanceof Error ? error.message : '脚本生成失败'
    return Response.json({ error: message.slice(0, 300) }, { status: 502 })
  }
}
