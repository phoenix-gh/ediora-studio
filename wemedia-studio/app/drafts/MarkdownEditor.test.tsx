// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
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

  it('hydrates before applying a resolved dark theme', async () => {
    const props = { value: '# Draft', onChange: vi.fn() }
    themeState.resolvedTheme = undefined

    const container = document.createElement('div')
    container.innerHTML = renderToString(<MarkdownEditor {...props} />)
    document.body.append(container)
    expect(container.firstElementChild).toHaveAttribute('data-color-mode', 'light')

    themeState.resolvedTheme = 'dark'
    const recoverableErrors: unknown[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let root: Root | undefined

    try {
      await act(async () => {
        root = hydrateRoot(container, <MarkdownEditor {...props} />, {
          onRecoverableError: error => recoverableErrors.push(error),
        })
      })

      await waitFor(() => {
        expect(container.firstElementChild).toHaveAttribute('data-color-mode', 'dark')
      })
      expect(recoverableErrors).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      await act(async () => root?.unmount())
      consoleError.mockRestore()
      container.remove()
    }
  })
})
