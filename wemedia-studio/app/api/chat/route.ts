import { createOpenAI } from '@ai-sdk/openai'
import { convertToModelMessages, generateText, safeValidateUIMessages, stepCountIs, streamText, type UIMessage } from 'ai'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { latestClientTurn, modelHistoryCandidates } from '@/lib/ai/chat-tools'
import { buildChatInstructions } from '@/lib/ai/chat-instructions'
import { CHAT_MAX_STEPS, chatToolLoopStep, needsFinalAnswerFallback } from '@/lib/ai/chat-loop'
import { baoyuRuntimeInstructions } from '@/lib/ai/content-job'
import { openGlobalChatTools } from '@/lib/ai/global-chat-tools'
import { workerHeaders } from '@/lib/ai/job-client'
import { getEnabledSkill, listSkillReferences } from '@/lib/skills/registry'

const requestSchema = z.object({
  sessionId: z.number().int().positive(),
  messages: z.array(z.unknown()).max(50).default([]),
  skillName: z.string().min(1).max(200).optional(),
  draftId: z.number().int().positive().optional(),
  approval: z.object({
    messageId: z.number().int().positive(),
    toolCallId: z.string().min(1).max(200),
    approvalId: z.string().min(1).max(200),
    approved: z.boolean(),
  }).optional(),
})

const apiBase = () => (process.env.WMS_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')

type ModelConfig = { apiKey: string; modelName: string; baseURL?: string }

async function configuredTextModel(): Promise<ModelConfig> {
  try {
    const response = await fetch(`${apiBase()}/settings/ai-runtime`, {
      cache: 'no-store',
      headers: workerHeaders(),
    })
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

async function persistedModelHistory(sessionId: number, includeToolApprovals = false) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load chat session (${response.status})`)
  const session = await response.json() as PersistedChatSession
  const validated = await safeValidateUIMessages({ messages: modelHistoryCandidates(session.messages, { includeToolApprovals }) })
  if (!validated.success) throw new Error('Persisted chat history is invalid')
  return validated.data
}

async function persistApproval(sessionId: number, approval: NonNullable<z.infer<typeof requestSchema>['approval']>) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load chat session (${response.status})`)
  const session = await response.json() as PersistedChatSession
  const message = session.messages.find(item => item.id === approval.messageId && item.role === 'assistant')
  if (!message) throw new Error('The pending tool approval message is unavailable')
  let matched = false
  const parts = message.parts.map(part => {
    if (!part || typeof part !== 'object') return part
    const record = part as Record<string, unknown>
    const pendingApproval = record.approval
    if (record.toolCallId !== approval.toolCallId || !pendingApproval || typeof pendingApproval !== 'object' || (pendingApproval as Record<string, unknown>).id !== approval.approvalId) return part
    matched = true
    return { ...record, state: 'approval-responded', approval: { ...(pendingApproval as Record<string, unknown>), approved: approval.approved } }
  })
  if (!matched) throw new Error('The pending tool approval no longer matches this session')
  const updated = await fetch(`${apiBase()}/chat/sessions/${sessionId}/messages/${message.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts }),
  })
  if (!updated.ok) throw new Error(`Unable to persist tool approval (${updated.status})`)
}

export async function selectedSkillContext(skillName: string) {
  const skill = await getEnabledSkill(skillName)
  if (!skill) throw new Error('Selected skill is unavailable')
  const references = await listSkillReferences(skillName)
  const catalog = references.length
    ? references.map(reference => `- ${reference.path} (${reference.bytes} bytes)`).join('\n')
    : '- No readable references'
  const runtime = skill.name === 'baoyu-cover-image'
    ? `${baoyuRuntimeInstructions('cover', 1)} Use generateImage to create the cover for the selected draft.\n\n`
    : skill.name === 'baoyu-article-illustrator'
      ? `${baoyuRuntimeInstructions('illustrations', 1)} Use generateImage to create the illustration for the selected draft.\n\n`
      : ''
  return `Selected skill: ${skill.name}\n\n${runtime}${skill.instructions}\n\nAvailable Skill references:\n${catalog}\n\nWhen the selected Skill requires one of these files, call readSkillReference with its exact listed path. Do not invent missing reference content.`
}

async function selectedContext(skillName?: string, draftId?: number) {
  const context: string[] = []
  if (skillName) {
    context.push(await selectedSkillContext(skillName))
  }
  if (draftId) {
    const response = await fetch(`${apiBase()}/write/drafts/${draftId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('Selected draft is unavailable')
    const draft = await response.json() as { title: string; content: string }
    context.push(`Selected draft: ${draft.title}\n\n${draft.content}`)
  }
  return context.join('\n\n---\n\n')
}

function conversationForRecovery(messages: UIMessage[]) {
  return messages
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${messageText(message)}`)
    .filter(line => line.trim().length > 3)
    .join('\n\n')
    .slice(-16_000)
}

async function recoverFinalAnswer({
  provider,
  modelName,
  messages,
  instructions,
}: {
  provider: ReturnType<typeof createOpenAI>
  modelName: string
  messages: UIMessage[]
  instructions: string
}) {
  const recovery = await generateText({
    model: provider.chat(modelName),
    instructions: `${instructions}\n\nYou are in the final-answer recovery phase. Do not call tools, do not emit tool-call markup, and reply directly to the user in their language. Use only the conversation context below; be transparent if it lacks evidence.`,
    prompt: conversationForRecovery(messages),
  })
  return recovery.text.trim()
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof requestSchema>
  try {
    body = requestSchema.parse(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid chat request' }, { status: 400 })
  }

  let latestMessage: UIMessage | undefined
  if (!body.approval) {
    const clientLatestMessage = latestClientTurn(body.messages)
    const validatedClientTurn = await safeValidateUIMessages({ messages: clientLatestMessage ? [clientLatestMessage] : [] })
    if (!validatedClientTurn.success) {
      return NextResponse.json({ error: 'Invalid chat messages' }, { status: 400 })
    }
    latestMessage = validatedClientTurn.data.at(-1)
    if (!latestMessage || latestMessage.role !== 'user') {
      return NextResponse.json({ error: 'The latest chat message must be from the user' }, { status: 400 })
    }
  }

  let registry: Awaited<ReturnType<typeof openGlobalChatTools>> | undefined
  try {
    if (body.approval) await persistApproval(body.sessionId, body.approval)
    else if (latestMessage) await persistMessage(body.sessionId, { role: 'user', parts: latestMessage.parts })
    registry = await openGlobalChatTools({ apiBase: apiBase(), sessionId: body.sessionId, draftId: body.draftId, skillName: body.skillName })
    const messages = await persistedModelHistory(body.sessionId, Boolean(body.approval))
    const modelConfig = await configuredTextModel()
    const context = await selectedContext(body.skillName, body.draftId)
    const provider = createOpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL })
    const instructions = buildChatInstructions(context)
    const result = streamText({
      model: provider.chat(modelConfig.modelName),
      instructions,
      messages: await convertToModelMessages(messages, { tools: registry.tools, ignoreIncompleteToolCalls: true }),
      tools: registry.tools,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      prepareStep: ({ stepNumber }) => {
        const stepPolicy = chatToolLoopStep(stepNumber)
        if (!stepPolicy) return undefined
        return {
          ...stepPolicy,
          activeTools: [],
          instructions: `${instructions}\n\nResearch is complete. No tools are available for this step. Do not emit tool-call markup or XML. Now write the final answer in the user's language, using the evidence already collected.`,
        }
      },
    })

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: async ({ responseMessage, isAborted }) => {
        try {
          if (!isAborted) {
            const pendingApproval = responseMessage.parts.some(part => part.type === 'dynamic-tool' && part.state === 'approval-requested')
            let parts = responseMessage.parts
            if (!pendingApproval && needsFinalAnswerFallback(messageText(responseMessage))) {
              try {
                const recoveredText = await recoverFinalAnswer({ provider, modelName: modelConfig.modelName, messages, instructions })
                if (!needsFinalAnswerFallback(recoveredText)) parts = [{ type: 'text', text: recoveredText }]
              } catch {
                // Persist the clear fallback below if the recovery call itself fails.
              }
            }
            const finalHasText = messageText({ parts }).trim().length > 0
            await persistMessage(body.sessionId, {
              role: 'assistant',
              parts: finalHasText || pendingApproval ? parts : [{ type: 'text', text: '本次回复没有生成有效内容。请重试；如果问题持续出现，请缩小检索范围。' }],
            })
          }
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
