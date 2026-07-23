import { createOpenAI } from '@ai-sdk/openai'
import { convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText, type UIMessage } from 'ai'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { latestClientTurn, modelHistoryCandidates } from '@/lib/ai/chat-tools'
import { baoyuRuntimeInstructions } from '@/lib/ai/content-job'
import { discoverSkills } from '@/lib/ai/discover-skills'
import { openGlobalChatTools } from '@/lib/ai/global-chat-tools'

const requestSchema = z.object({
  sessionId: z.number().int().positive(),
  messages: z.array(z.unknown()).min(1).max(50),
  skillName: z.string().min(1).max(200).optional(),
  draftId: z.number().int().positive().optional(),
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

type PersistedChatSession = {
  messages: Array<{ id: number; role: 'user' | 'assistant' | 'tool'; parts: unknown[] }>
}

function messageText(message: Pick<UIMessage, 'parts'>) {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
}

async function persistMessage(sessionId: number, message: Pick<UIMessage, 'parts'> & { role: 'user' | 'assistant' }) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: message.role, parts: message.parts, text: messageText(message) }),
  })
  if (!response.ok) throw new Error(`Unable to persist chat message (${response.status})`)
}

async function persistedModelHistory(sessionId: number) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load chat session (${response.status})`)
  const session = await response.json() as PersistedChatSession
  const validated = await safeValidateUIMessages({ messages: modelHistoryCandidates(session.messages) })
  if (!validated.success) throw new Error('Persisted chat history is invalid')
  return validated.data
}

async function selectedContext(skillName?: string, draftId?: number) {
  const context: string[] = []
  if (skillName) {
    const skill = (await discoverSkills()).find(item => item.name === skillName)
    if (!skill) throw new Error('Selected skill is unavailable')
    if (skill.name === 'baoyu-cover-image') {
      context.push(`Selected skill: ${skill.name}\n\n${baoyuRuntimeInstructions('cover', 1)} Use generateImage to create the cover for the selected draft.`)
    } else if (skill.name === 'baoyu-article-illustrator') {
      context.push(`Selected skill: ${skill.name}\n\n${baoyuRuntimeInstructions('illustrations', 1)} Use generateImage to create the illustration for the selected draft.`)
    } else {
      context.push(`Selected skill: ${skill.name}\n\n${skill.instructions}`)
    }
  }
  if (draftId) {
    const response = await fetch(`${apiBase()}/write/drafts/${draftId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('Selected draft is unavailable')
    const draft = await response.json() as { title: string; content: string }
    context.push(`Selected draft: ${draft.title}\n\n${draft.content}`)
  }
  return context.join('\n\n---\n\n')
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof requestSchema>
  try {
    body = requestSchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid chat request' }, { status: 400 })
  }

  const clientLatestMessage = latestClientTurn(body.messages)
  const validatedClientTurn = await safeValidateUIMessages({ messages: clientLatestMessage ? [clientLatestMessage] : [] })
  if (!validatedClientTurn.success) {
    return NextResponse.json({ error: 'Invalid chat messages' }, { status: 400 })
  }

  const latestMessage = validatedClientTurn.data.at(-1)
  if (!latestMessage || latestMessage.role !== 'user') {
    return NextResponse.json({ error: 'The latest chat message must be from the user' }, { status: 400 })
  }

  let registry: Awaited<ReturnType<typeof openGlobalChatTools>> | undefined
  try {
    await persistMessage(body.sessionId, { role: 'user', parts: latestMessage.parts })
    registry = await openGlobalChatTools({ apiBase: apiBase(), sessionId: body.sessionId, draftId: body.draftId, skillName: body.skillName })
    const messages = await persistedModelHistory(body.sessionId)
    const modelConfig = await configuredTextModel()
    const context = await selectedContext(body.skillName, body.draftId)
    const provider = createOpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL })
    const result = streamText({
      model: provider.chat(modelConfig.modelName),
      instructions: `You are WeMedia Studio’s global workspace assistant. Use the available tools when they are relevant, clearly distinguish tool results from inference, and only claim an action succeeded after its tool reports success. Sensitive actions may require user approval.${context ? `\n\nSelected turn context:\n${context}` : ''}`,
      messages: await convertToModelMessages(messages, { tools: registry.tools, ignoreIncompleteToolCalls: true }),
      tools: registry.tools,
      stopWhen: stepCountIs(8),
    })

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: async ({ responseMessage, isAborted }) => {
        try {
          if (!isAborted) await persistMessage(body.sessionId, { role: 'assistant', parts: responseMessage.parts })
        } finally {
          await registry?.close()
        }
      },
    })
  } catch (error) {
    await registry?.close()
    const message = error instanceof Error ? error.message : 'Chat request failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
