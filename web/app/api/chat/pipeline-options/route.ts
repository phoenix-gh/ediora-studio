import { NextResponse } from 'next/server'

import {
  listPipelineParameterOptions,
  PipelineResolutionError,
  type PipelineParameterKind,
} from '@/lib/ai/pipeline-resolver'

function errorResponse(error: unknown) {
  if (error instanceof PipelineResolutionError) {
    return NextResponse.json({ detail: error.message }, { status: error.status })
  }
  const message = error instanceof Error ? error.message : '参数列表加载失败'
  return NextResponse.json({ detail: message }, { status: 502 })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  const query = url.searchParams.get('query') ?? ''
  if (kind !== 'writing_plan' && kind !== 'publish_account') {
    return NextResponse.json({ detail: 'kind 必须是 writing_plan 或 publish_account' }, { status: 400 })
  }
  try {
    return NextResponse.json({ options: await listPipelineParameterOptions(kind as PipelineParameterKind, query) })
  } catch (error) {
    return errorResponse(error)
  }
}
