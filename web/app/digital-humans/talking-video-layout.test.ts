import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


describe('talking video workbench layout', () => {
  it('keeps the approved desktop column proportions', () => {
    const source = readFileSync(
      new URL('./TalkingVideoEditor.tsx', import.meta.url),
      'utf8',
    )
    const studio = readFileSync(
      new URL('./DigitalHumansClient.tsx', import.meta.url),
      'utf8',
    )

    expect(studio).toContain('grid-cols-[220px_minmax(0,1fr)]')
    expect(studio).toContain('key={selectedProject.id}')
    expect(studio).toContain('h-full min-h-0 flex-col overflow-hidden')
    expect(source).toContain(
      'min-[1360px]:grid-cols-[200px_minmax(320px,1fr)_280px]',
    )
    expect(source).toContain('h-full min-h-0 min-w-0 gap-4 overflow-hidden')
    expect(source).not.toContain('min-h-[68vh]')
    expect(source).toContain('talking-config-column')
    expect(source).toContain('talking-script-column')
    expect(source).toContain('talking-render-column')
  })
})
