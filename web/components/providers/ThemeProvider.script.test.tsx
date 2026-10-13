// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThemeProvider } from './ThemeProvider'

describe('ThemeProvider server markup', () => {
  it('emits an executable theme script so the class is set before paint', () => {
    const html = renderToString(
      <ThemeProvider>
        <span>content</span>
      </ThemeProvider>,
    )

    expect(html).toContain('<span>content</span>')
    expect(html).toContain('<script')
    expect(html).not.toContain('application/json')
  })
})
