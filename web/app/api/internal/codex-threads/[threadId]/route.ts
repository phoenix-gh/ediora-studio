import { timingSafeEqual } from 'node:crypto'

import { NextResponse } from 'next/server'

import { deleteCodexThread } from '@/lib/ai/codex-app-server-client'
import { codexThreadId } from '@/lib/ai/codex-thread'

function workerTokenAccepted(supplied: string | null) {
  const expected = process.env.WORKER_TOKEN ?? ''
  if (expected.length < 32 || supplied === null) return false
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  if (suppliedBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(suppliedBytes, expectedBytes)
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  if (!workerTokenAccepted(request.headers.get('x-worker-token'))) {
    return NextResponse.json({ error: '后台 worker 令牌无效' }, { status: 403 })
  }
  const { threadId: rawThreadId } = await context.params
  const threadId = codexThreadId(decodeURIComponent(rawThreadId))
  if (!threadId) {
    return NextResponse.json({ error: 'Codex thread id 无效' }, { status: 400 })
  }
  try {
    await deleteCodexThread(threadId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Codex 会话删除失败'
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 })
  }
  return new NextResponse(null, { status: 204 })
}
