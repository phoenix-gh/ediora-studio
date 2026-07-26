import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


describe('talking video workbench layout', () => {
  it('keeps the approved desktop column proportions', () => {
    const source = readFileSync(
      new URL('./TalkingVideoEditor.tsx', import.meta.url),
      'utf8',
    )

    expect(source).toContain('grid-cols-[260px_minmax(420px,1fr)_360px]')
    expect(source).toContain('talking-config-column')
    expect(source).toContain('talking-script-column')
    expect(source).toContain('talking-render-column')
  })
})
