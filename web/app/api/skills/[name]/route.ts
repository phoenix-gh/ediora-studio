import { NextResponse } from 'next/server'

import { setSkillEnabled, deleteUploadedSkill } from '@/lib/skills/registry'
import { skillErrorResponse } from '../errors'

type RouteContext = { params: Promise<{ name: string }> }

export async function PATCH(request: Request, context: RouteContext) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ detail: 'Request body must be valid JSON' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { enabled?: unknown }).enabled !== 'boolean') {
    return NextResponse.json({ detail: 'enabled must be a boolean' }, { status: 400 })
  }

  try {
    const { name } = await context.params
    return NextResponse.json(await setSkillEnabled(decodeURIComponent(name), (body as { enabled: boolean }).enabled))
  } catch (error) {
    return skillErrorResponse(error)
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { name } = await context.params
    await deleteUploadedSkill(decodeURIComponent(name))
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return skillErrorResponse(error)
  }
}
