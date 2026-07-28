// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const provider = vi.hoisted(() => vi.fn(({ children }) => <>{children}</>))
vi.mock('next-themes', () => ({ ThemeProvider: provider }))

import { ThemeProvider } from './ThemeProvider'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ThemeProvider', () => {
  it('uses class themes with system as the default', () => {
    render(<ThemeProvider><span>content</span></ThemeProvider>)
    expect(screen.getByText('content')).toBeTruthy()
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({
      attribute: 'class',
      defaultTheme: 'system',
      enableSystem: true,
      disableTransitionOnChange: true,
    }), undefined)
  })
})
