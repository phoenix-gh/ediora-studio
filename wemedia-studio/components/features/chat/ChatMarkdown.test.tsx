// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ChatMarkdown } from './ChatMarkdown'

describe('ChatMarkdown', () => {
  it('renders common markdown structures', () => {
    render(<ChatMarkdown content={'## 标题\n\n- 第一项\n\n```ts\nconst ok = true\n```\n\n[文档](https://example.com)'} />)

    expect(screen.getByRole('heading', { name: '标题', level: 2 })).not.toBeNull()
    expect(screen.getByRole('list').textContent).toContain('第一项')
    expect(screen.getByText('const ok = true')).not.toBeNull()
    expect(screen.getByRole('link', { name: '文档' }).getAttribute('href')).toBe('https://example.com')
  })

  it('keeps raw HTML as text instead of creating elements', () => {
    const { container } = render(<ChatMarkdown content={'<img src=x onerror=alert(1)>'} />)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).not.toBeNull()
  })
})
