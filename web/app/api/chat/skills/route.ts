import { NextResponse } from 'next/server'

import { discoverSkills } from '@/lib/ai/discover-skills'

export async function GET() {
  const skills = await discoverSkills()
  return NextResponse.json(skills.map(({ name, description, version }) => ({ name, description, version })))
}
