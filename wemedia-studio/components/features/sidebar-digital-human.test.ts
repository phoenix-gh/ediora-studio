import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


describe('digital-human navigation', () => {
  it('uses the unambiguous creation menu label', () => {
    const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')

    expect(source).toContain("label: '数字人口播'")
    expect(source).toContain("href: '/digital-humans'")
  })
})
