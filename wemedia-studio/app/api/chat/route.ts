import { createOpenAI } from '@ai-sdk/openai'
import { convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText, type UIMessage } from 'ai'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { makeChatTools } from '@/lib/ai/chat-tools'

const requestSchema = z.object({
  sessionId: z.number().int().positive(),
  messages: z.array(z.unknown()).min(1).max(50),
})

const apiBase = () => (process.env.WMS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')

type ModelConfig = { apiKey: string; modelName: string; baseURL?: string }

async function configuredTextModel(): Promise<ModelConfig> {
  try {
    const response = await fetch(`${apiBase()}/settings/ai-runtime`, { cache: 'no-store' })
    if (response.ok) {
      const settings = await response.json() as { api_key: string; model: string; base_url: string }
      if (settings.api_key) {
        return { apiKey: settings.api_key, modelName: settings.model || 'gpt-4o-mini', baseURL: settings.base_url || undefined }
      }
    }
  } catch {
    // Environment variables keep local and Docker development usable.
  }

  const apiKey = process.env.WMS_LLM_API_KEY
  if (!apiKey) throw new Error('No LLM API key is configured in Settings or WMS_LLM_API_KEY')
  return {
    apiKey,
    modelName: process.env.WMS_LLM_MODEL ?? 'gpt-4o-mini',
    baseURL: process.env.WMS_LLM_BASE_URL,
  }
}

function messageText(message: Pick<UIMessage, 'parts'>) {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
}

async function persistMessage(sessionId: number, message: Pick<UIMessage, 'role' | 'parts'>) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: message.role, parts: message.parts, text: messageText(message) }),
  })
  if (!response.ok) throw new Error(`Unable to persist chat message (${response.status})`)
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof requestSchema>
  try {
    body = requestSchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid chat request' }, { status: 400 })
  }

  const tools = makeChatTools({ apiBase: apiBase(), sessionId: body.sessionId })
  const validated = await safeValidateUIMessages({ messages: body.messages })
  if (!validated.success || validated.data.some(message => message.role === 'system')) {
    return NextResponse.json({ error: 'Invalid chat messages' }, { status: 400 })
  }

  const messages = validated.data
  const latestMessage = messages.at(-1)
  if (!latestMessage || latestMessage.role !== 'user') {
    return NextResponse.json({ error: 'The latest chat message must be from the user' }, { status: 400 })
  }

  try {
    await persistMessage(body.sessionId, latestMessage)
    const modelConfig = await configuredTextModel()
    const provider = createOpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL })
    const result = streamText({
      model: provider.chat(modelConfig.modelName),
      instructions: 'You are WeMedia Studio’s research assistant. Use the read-only information-source tools when local sources are relevant. Cite source titles in your answer, distinguish source facts from inference, and never claim to have created or changed content.',
      messages: await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true }),
      tools,
      stopWhen: stepCountIs(4),
    })

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: async ({ responseMessage, isAborted }) => {
        if (!isAborted) await persistMessage(body.sessionId, responseMessage)
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chat request failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
