import { NextRequest, NextResponse } from 'next/server'

import { runContentJob } from '@/lib/ai/content-job'

export async function POST(_request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params
  if (!/^\d+$/.test(jobId)) return NextResponse.json({ error: 'Invalid job id' }, { status: 400 })

  try {
    return NextResponse.json(await runContentJob(Number(jobId)))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Content job failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
