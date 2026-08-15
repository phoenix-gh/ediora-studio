import { NextResponse } from 'next/server'

import { listSkills } from '@/lib/skills/registry'
import { skillErrorResponse } from './errors'

export async function GET() {
  try {
    return NextResponse.json(await listSkills())
  } catch (error) {
    return skillErrorResponse(error)
  }
}
