import { NextResponse } from 'next/server'
import { z } from 'zod'

import { apiBase, workerHeaders } from '@/lib/ai/job-client'
import {
  PipelineResolutionError,
  resolvePipelineInvocations,
  type SubmittedSkillInvocation,
} from '@/lib/ai/pipeline-resolver'

const submittedInvocation = z.object({
  invocationId: z.string().trim().min(1).max(120),
  skillName: z.string().trim().min(1).max(80),
  skillDisplayName: z.string().trim().min(1).max(200),
  parameterKind: z.enum(['writing_plan', 'publish_account']).optional(),
  parameterId: z.string().trim().min(1).max(120).optional(),
  parameterDisplayName: z.string().trim().min(1).max(200).optional(),
}).strict()

const messagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(20_000) }).strict(),
  submittedInvocation.extend({ type: z.literal('skill-invocation') }).strict(),
])

const bodySchema = z.object({
  clientMessageId: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(500).default('Skill Pipeline'),
  invocations: z.array(submittedInvocation).min(1).max(24),
  messageParts: z.array(messagePart).min(1).max(200),
}).strict().superRefine((body, context) => {
  const messageInvocationIds = body.messageParts
    .filter(part => part.type === 'skill-invocation')
    .map(part => part.invocationId)
  const invocationIds = body.invocations.map(invocation => invocation.invocationId)
  if (messageInvocationIds.length !== invocationIds.length
    || messageInvocationIds.some((id, index) => id !== invocationIds[index])) {
    context.addIssue({ code: 'custom', path: ['messageParts'], message: '消息中的 Skill 顺序与 Pipeline 不一致' })
  }
  const visibleObjective = body.messageParts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
    .trim()
  if (visibleObjective !== body.objective) {
    context.addIssue({ code: 'custom', path: ['objective'], message: '消息正文与执行目标不一致' })
  }
})

type RouteContext = { params: Promise<{ sessionId: string }> }

function errorResponse(error: unknown) {
  if (error instanceof PipelineResolutionError) {
    return NextResponse.json({ detail: error.message }, { status: error.status })
  }
  const message = error instanceof Error ? error.message : 'Pipeline 创建失败'
  return NextResponse.json({ detail: message }, { status: 502 })
}

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params
  if (!/^\d+$/.test(sessionId) || Number(sessionId) <= 0) {
    return NextResponse.json({ detail: '会话 ID 无效' }, { status: 400 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ detail: '请求体必须是有效 JSON' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ detail: 'Pipeline 请求参数无效' }, { status: 400 })
  }

  try {
    const invocations = await resolvePipelineInvocations(parsed.data.invocations as SubmittedSkillInvocation[])
    const response = await fetch(`${apiBase()}/chat/sessions/${sessionId}/pipelines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workerHeaders() },
      body: JSON.stringify({
        client_message_id: parsed.data.clientMessageId,
        objective: parsed.data.objective,
        title: parsed.data.title,
        invocations,
        message_parts: parsed.data.messageParts.map(part => part.type === 'text'
          ? part
          : { type: part.type, invocation_id: part.invocationId }),
      }),
      cache: 'no-store',
    })
    let payload: unknown = {}
    try {
      payload = await response.json()
    } catch {
      payload = { detail: response.statusText || 'Pipeline 创建失败' }
    }
    return NextResponse.json(payload, { status: response.status })
  } catch (error) {
    return errorResponse(error)
  }
}
