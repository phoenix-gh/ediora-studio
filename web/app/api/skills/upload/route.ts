import { NextResponse } from 'next/server'

import { installSkillArchive } from '@/lib/skills/registry'
import { skillErrorResponse } from '../errors'

export async function POST(request: Request) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ detail: 'Request must be multipart form data' }, { status: 400 })
  }
  const file = form.get('file')
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return NextResponse.json({ detail: 'A ZIP file is required in the file field' }, { status: 400 })
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return NextResponse.json(await installSkillArchive(bytes), { status: 201 })
  } catch (error) {
    return skillErrorResponse(error)
  }
}
