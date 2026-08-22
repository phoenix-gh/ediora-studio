import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')
const scrollArea = readFileSync(resolve(process.cwd(), 'components/ui/scroll-area.tsx'), 'utf8')

describe('application scrollbar styling', () => {
  it('defines compact themed native scrollbar styles', () => {
    expect(css).toContain('--scrollbar-thumb:')
    expect(css).toContain('--scrollbar-thumb-hover:')
    expect(css).toContain('scrollbar-width: thin')
    expect(css).toContain('scrollbar-color: var(--scrollbar-thumb) transparent')
    expect(css).toContain('*::-webkit-scrollbar')
    expect(css).toMatch(/\*::\-webkit-scrollbar\s*\{[^}]*width:\s*6px/)
    expect(css).toMatch(/\*::\-webkit-scrollbar\s*\{[^}]*height:\s*6px/)
    expect(css).toContain('*::-webkit-scrollbar-track')
    expect(css).toContain('*::-webkit-scrollbar-thumb')
    expect(css).toContain('border-radius: 999px')
    expect(css).toContain('*::-webkit-scrollbar-corner')
  })

  it('keeps the shared ScrollArea scrollbar compact and themed', () => {
    expect(scrollArea).toContain('data-horizontal:h-1.5')
    expect(scrollArea).toContain('data-vertical:w-1.5')
    expect(scrollArea).toContain('bg-border-strong')
    expect(scrollArea).toContain('hover:bg-foreground-subtle')
  })
})
