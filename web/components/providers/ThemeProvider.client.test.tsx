// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeProvider } from './ThemeProvider'

afterEach(() => {
  cleanup()
  document.documentElement.className = ''
})

describe('ThemeProvider client markup', () => {
  it('renders the theme script as a data block so React 19 does not reject it', () => {
    const { container } = render(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>,
    )

    const script = container.querySelector('script')
    expect(script?.getAttribute('type')).toBe('application/json')
    expect(script?.textContent).toContain('localStorage')
    expect(container.querySelector('span')?.textContent).toBe('content')
  })
})
