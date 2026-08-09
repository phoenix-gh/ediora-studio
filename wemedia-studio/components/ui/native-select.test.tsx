// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NativeSelect } from './native-select'

const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

describe('NativeSelect', () => {
  it('renders the themed native select contract', () => {
    render(
      <NativeSelect aria-label="主题">
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </NativeSelect>,
    )

    expect(screen.getByLabelText('主题')).toHaveAttribute('data-slot', 'native-select')
    expect(screen.getByLabelText('主题')).toHaveClass(
      'bg-control',
      'text-foreground',
      '[color-scheme:light]',
      'dark:[color-scheme:dark]',
    )
  })

  it('styles native options with the semantic surface and foreground', () => {
    expect(css).toContain("[data-slot='native-select'] option")
    expect(css).toMatch(/background-color:\s*var\(--surface\)/)
    expect(css).toMatch(/color:\s*var\(--foreground\)/)
  })
})
