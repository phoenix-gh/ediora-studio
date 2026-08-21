import { generateText } from 'ai'

import {
  buildTalkingScriptPrompt,
  cleanTalkingScript,
  talkingScriptRequestSchema,
} from '@/lib/ai/talking-script'
import { workerHeaders } from '@/lib/ai/job-client'
import {
  textModelConfigFromSettings,
  textModelFromConfig,
  type TextModelConfig,
  type TextModelSettings,
} from '@/lib/ai/runtime-config'


const apiBase = () => (
  process.env.API_URL
  ?? process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:8000/api'
).replace(/\/$/, '')


async function configuredModel(): Promise<TextModelConfig> {
  const response = await fetch(`${apiBase()}/settings/ai-runtime`, {
    cache: 'no-store',
    headers: workerHeaders(),
  })
  if (!response.ok) throw new Error('无法读取设置中的文本模型配置')
  const settings = textModelConfigFromSettings(
    await response.json() as TextModelSettings,
  )
  return settings
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
    const result = await generateText({
      model: textModelFromConfig(modelConfig),
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
