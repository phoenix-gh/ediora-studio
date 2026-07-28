// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const themeState = vi.hoisted((): { resolvedTheme: string | undefined } => ({
  resolvedTheme: 'light',
}))

vi.mock('next-themes', () => ({
  useTheme: () => themeState,
}))

vi.mock('next/dynamic', () => ({
  default: () => function MarkdownEditorStub() {
    return <div aria-label="Markdown editor" />
  },
}))

import { MarkdownEditor } from './MarkdownEditor'

describe('MarkdownEditor theme', () => {
  beforeEach(() => {
    themeState.resolvedTheme = 'light'
  })

  it('uses the resolved light theme and immediately follows a switch to dark', () => {
    const props = { value: '# Draft', onChange: vi.fn() }
    const { container, rerender } = render(<MarkdownEditor {...props} />)

    expect(container.firstElementChild).toHaveAttribute('data-color-mode', 'light')

    themeState.resolvedTheme = 'dark'
    rerender(<MarkdownEditor {...props} />)

    expect(container.firstElementChild).toHaveAttribute('data-color-mode', 'dark')
  })

  it('uses a hydration-safe light fallback until the resolved theme is known', () => {
    themeState.resolvedTheme = undefined

    const props = { value: '# Draft', onChange: vi.fn() }
    const { container, rerender } = render(<MarkdownEditor {...props} />)

    expect(container.firstElementChild).toHaveAttribute('data-color-mode', 'light')

    themeState.resolvedTheme = 'dark'
    rerender(<MarkdownEditor {...props} />)

    expect(container.firstElementChild).toHaveAttribute('data-color-mode', 'dark')
  })
})
