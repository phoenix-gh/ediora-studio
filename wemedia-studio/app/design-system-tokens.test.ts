import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

const REQUIRED_TOKENS = [
  '--surface:',
  '--surface-muted:',
  '--foreground-subtle:',
  '--border-strong:',
  '--data:',
  '--data-foreground:',
  '--data-subtle:',
  '--ai:',
  '--ai-foreground:',
  '--ai-subtle:',
  '--success:',
  '--warning:',
  '--danger:',
  '--info:',
]

describe('Ediora design tokens', () => {
  it.each(REQUIRED_TOKENS)('defines %s in light and dark themes', token => {
    expect(css.split(token)).toHaveLength(3)
  })

  it('maps the sans font to Geist instead of itself', () => {
    expect(css).toContain('--font-sans: var(--font-geist-sans)')
    expect(css).not.toContain('--font-sans: var(--font-sans)')
  })
})
