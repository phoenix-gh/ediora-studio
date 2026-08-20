import { NextResponse } from 'next/server'

import { isDeveloperModeEnabled } from '@/lib/developer-mode'

export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    {
      developerMode: isDeveloperModeEnabled(process.env.DEVELOPER_MODE),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
