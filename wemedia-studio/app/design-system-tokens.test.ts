import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

function parseThemeTokens(selector: ':root' | '.dark') {
  const escapedSelector = selector.replace('.', '\\.')
  const block = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1]

  if (!block) throw new Error(`Missing ${selector} theme block`)

  return Object.fromEntries(
    Array.from(block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g), match => [
      match[1],
      match[2].trim(),
    ]),
  )
}

function relativeLuminance(hex: string) {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map(channel => Number.parseInt(channel, 16) / 255)

  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex color, received ${hex}`)
  }

  const [red, green, blue] = channels.map(channel =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  )

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(first: string, second: string) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second))
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

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

  it.each([
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const)('keeps %s primary text at WCAG AA contrast', (_theme, selector) => {
    const tokens = parseThemeTokens(selector)

    expect(
      contrastRatio(tokens['--primary'], tokens['--primary-foreground']),
    ).toBeGreaterThanOrEqual(4.5)
  })
})
