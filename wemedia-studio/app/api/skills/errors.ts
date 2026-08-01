import { NextResponse } from 'next/server'

import { SkillRegistryError } from '@/lib/skills/registry'

const statusByCode = {
  not_found: 404,
  conflict: 409,
  forbidden: 409,
  invalid_archive: 400,
  too_large: 413,
} as const

export function skillErrorResponse(error: unknown) {
  if (error instanceof SkillRegistryError) {
    return NextResponse.json({ detail: error.message }, { status: statusByCode[error.code] })
  }
  return NextResponse.json({ detail: 'Skill operation failed' }, { status: 500 })
}
