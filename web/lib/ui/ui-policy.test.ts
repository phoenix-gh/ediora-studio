import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATED_FILES = [
  'app/page.tsx',
  'app/assets/AssetsClient.tsx',
  'app/settings/SettingsClient.tsx',
  'components/features/Sidebar.tsx',
  'components/features/CreateTaskDialog.tsx',
  'components/features/dashboard/AlertsBar.tsx',
  'components/features/dashboard/ReleasesToday.tsx',
  'components/features/dashboard/SourceStatusGrid.tsx',
]

const FORBIDDEN = [
  /window\.(prompt|confirm|alert)\s*\(/,
  /(^|[^\w.])(prompt|confirm|alert)\s*\(/m,
  /\bml-56\b/,
  /\b(min-h-screen|h-screen)\b/,
]

describe('Phase 1 UI policy', () => {
  it.each(MIGRATED_FILES)('%s follows the migrated UI contract', file => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern)
  })
})
