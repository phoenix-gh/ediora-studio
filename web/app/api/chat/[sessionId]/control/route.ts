import { z } from 'zod'

import { ChatTurnConflict, controlChatTurn } from '@/lib/ai/chat-turn-control'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('interrupt') }).strict(),
  z.object({ action: z.literal('steer'), text: z.string().trim().min(1).max(20_000) }).strict(),
])

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId: rawId } = await context.params
  const sessionId = Number(rawId)
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return Response.json({ error: '会话 ID 无效' }, { status: 400 })
  let body: z.infer<typeof schema>
  try { body = schema.parse(await request.json()) }
  catch { return Response.json({ error: '无效的会话控制请求' }, { status: 400 }) }
  try {
    const result = await controlChatTurn(sessionId, body.action, body.action === 'steer' ? body.text : undefined)
    return Response.json({ accepted: true, ...result })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '控制任务失败' }, {
      status: error instanceof ChatTurnConflict ? 409 : 502,
    })
  }
}
