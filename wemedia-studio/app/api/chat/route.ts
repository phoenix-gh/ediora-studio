import { createOpenAI } from '@ai-sdk/openai'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, generateText, safeValidateUIMessages, stepCountIs, streamText, type ToolSet, type UIMessage } from 'ai'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { latestActivatedSkillName, latestClientTurn, modelHistoryCandidates } from '@/lib/ai/chat-tools'
import { buildChatInstructions } from '@/lib/ai/chat-instructions'
import { CHAT_MAX_STEPS, chatToolLoopStep, needsFinalAnswerFallback } from '@/lib/ai/chat-loop'
import { baoyuRuntimeInstructions } from '@/lib/ai/content-job'
import { agentSkillRunAudit, openAgentRuntime, type AgentRunResult } from '@/lib/ai/agent-runtime'
import { createDirectImageGenerator, mcpUrl, type ChatSkillSnapshot } from '@/lib/ai/global-chat-tools'
import { workerHeaders } from '@/lib/ai/job-client'
import { getEnabledSkill, listSkillReferences, loadSkillPreloadContext } from '@/lib/skills/registry'

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

async function persistMessage(
  sessionId: number,
  message: Pick<UIMessage, 'parts'> & { role: 'user' | 'assistant' },
  skillRun?: Record<string, unknown>,
) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: message.role, parts: message.parts, text: messageText(message), skill_run: skillRun }),
  })
  if (!response.ok) throw new Error(`Unable to persist chat message (${response.status})`)
}

async function persistedChatSession(sessionId: number) {
  const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load chat session (${response.status})`)
  return response.json() as Promise<PersistedChatSession>
}

async function persistedModelHistory(session: PersistedChatSession, includeToolApprovals = false) {
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
  const preload = await loadSkillPreloadContext(skillName)
  const catalog = references.length
    ? references.map(reference => `- ${reference.path} (${reference.bytes} bytes)`).join('\n')
    : '- No readable references'
  const runtime = skill.name === 'baoyu-cover-image'
    ? `${baoyuRuntimeInstructions('cover', 1)} Use generateImage to create the cover for the selected draft.\n\n`
    : skill.name === 'baoyu-article-illustrator'
      ? `${baoyuRuntimeInstructions('illustrations', 1)} Use generateImage to create the illustration for the selected draft.\n\n`
      : ''
  const preloaded = preload.references.length
    ? `\n\nPreloaded Skill references (already loaded; follow these rules):\n${preload.references.map(reference => `## ${reference.path}\n\n${reference.content}`).join('\n\n')}`
    : ''
  return `Selected skill: ${skill.name}\n\n${runtime}${skill.instructions}\n\nAvailable Skill references:\n${catalog}${preloaded}\n\nThe selected Skill and every preloaded reference above are available in this turn. Apply all relevant rules to the answer. Do not claim that this Skill or these references were not loaded. When the selected Skill requires a reference that was not preloaded, call readSkillReference with its exact listed path. Do not invent missing reference content.`
}

async function selectedContext(skillName: string | undefined, draftId: number | undefined, skillContext: string) {
  const context: string[] = []
  if (skillName) {
    context.push(await selectedSkillContext(skillName))
  } else {
    context.push(skillContext)
  }
  if (draftId) {
    const response = await fetch(`${apiBase()}/write/drafts/${draftId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('Selected draft is unavailable')
    const draft = await response.json() as { title: string; content: string }
    context.push(`Selected draft: ${draft.title}\n\n${draft.content}`)
  }
  return context.join('\n\n---\n\n')
}

export function skillAwareStepPolicy(stepNumber: number, skill: ChatSkillSnapshot, instructions: string) {
  const policy = chatToolLoopStep(stepNumber, skill)
  if (!policy) return undefined
  return {
    ...policy,
    instructions: `${instructions}\n\nResearch is complete. No tools are available for this step. Do not emit tool-call markup or XML. Now write the final answer in the user's language, using the evidence already collected.`,
  }
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

export function genericSkillRuntimeEnabled() {
  return process.env.WMS_GENERIC_SKILL_RUNTIME !== '0'
}

export function executionToolsForSelection(tools: ToolSet, genericRuntime: boolean, selected: boolean): ToolSet {
  if (!genericRuntime || selected) return tools
  return Object.fromEntries(Object.entries(tools).filter(([name]) => name !== 'loadSkill')) as ToolSet
}

export function agentRunUIResponse(result: AgentRunResult) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      if (result.kind === 'completed') {
        const id = 'agent-run-final'
        writer.write({ type: 'text-start', id })
        writer.write({ type: 'text-delta', id, delta: result.text })
        writer.write({ type: 'text-end', id })
        return
      }
      for (const part of result.parts) {
        const toolName = typeof part.toolName === 'string' ? part.toolName : undefined
        const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined
        if (!toolName || !toolCallId) continue
        writer.write({ type: 'tool-input-available', toolName, toolCallId, input: part.input, dynamic: true })
        const approval = part.approval
        const approvalId = approval && typeof approval === 'object'
          ? (approval as Record<string, unknown>).id
          : part.approvalId
        if (typeof approvalId === 'string') writer.write({ type: 'tool-approval-request', toolCallId, approvalId })
      }
    },
  })
  return createUIMessageStreamResponse({ stream })
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

  let registry: Awaited<ReturnType<typeof openAgentRuntime>> | undefined
  try {
    if (body.approval) await persistApproval(body.sessionId, body.approval)
    else if (latestMessage) await persistMessage(body.sessionId, { role: 'user', parts: latestMessage.parts })
    const session = await persistedChatSession(body.sessionId)
    const restoredSkillName = body.skillName ? undefined : latestActivatedSkillName(session.messages)
    const messages = await persistedModelHistory(session, Boolean(body.approval))
    const modelConfig = await configuredTextModel()
    const provider = createOpenAI({ apiKey: modelConfig.apiKey, baseURL: modelConfig.baseURL })
    const model = provider.chat(modelConfig.modelName)
    const currentRequest = [...messages].reverse().find(message => message.role === 'user')
    const currentRequestText = currentRequest ? messageText(currentRequest) : ''
    const genericRuntime = genericSkillRuntimeEnabled()
    const runtime = await openAgentRuntime({
      mcpEndpoint: mcpUrl(apiBase()),
      imageGenerator: createDirectImageGenerator(apiBase()),
      model,
      approvalPolicy: 'interactive',
      skillMode: body.skillName ? 'manual' : 'auto',
      skillName: body.skillName,
      restoredSkillName,
      draftId: body.draftId,
      automaticSelection: genericRuntime,
    })
    registry = runtime
    const selected = genericRuntime || body.skillName
      ? await runtime.prepare(currentRequestText)
      : runtime.selectedSkill
    const context = await selectedContext(selected?.skill.name ?? body.skillName, body.draftId, runtime.catalogContext)
    const instructions = buildChatInstructions(context)
    const executionTools = executionToolsForSelection(runtime.tools, genericRuntime, Boolean(selected))

    if (genericRuntime && selected) {
      const modelMessages = await convertToModelMessages(messages, { tools: runtime.tools, ignoreIncompleteToolCalls: true })
      const result = await runtime.run({
        objective: currentRequestText,
        modelMessages,
        selectedContext: body.draftId ? context : '',
        maxSteps: CHAT_MAX_STEPS,
      })
      const parts = result.parts as UIMessage['parts']
      await persistMessage(body.sessionId, { role: 'assistant', parts }, agentSkillRunAudit(result))
      await registry.close()
      registry = undefined
      return agentRunUIResponse(result)
    }

    const result = streamText({
      model,
      instructions,
      messages: await convertToModelMessages(messages, { tools: executionTools, ignoreIncompleteToolCalls: true }),
      tools: executionTools,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      prepareStep: ({ stepNumber }) => {
        return skillAwareStepPolicy(stepNumber, runtime.snapshot(), instructions)
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
