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

  it('renders workspace images through the image endpoint and makes downloads accessible', () => {
    const path = '/tmp/.ediora/codex_work/cover-image/google-registration/cover.png'
    render(<ChatMarkdown content={`![封面](${path})\n\n[下载封面](${path})`} />)
    const url = '/api/chat/workspace-image?path=cover-image%2Fgoogle-registration%2Fcover.png'
    expect(screen.getByRole('img', { name: '封面' })).toHaveAttribute('src', url)
    expect(screen.getByRole('link', { name: '下载封面' })).toHaveAttribute('href', url)
  })

  it('renders public images but rejects unsafe image schemes', () => {
    render(<ChatMarkdown content={'![外部图片](https://example.com/cover.png)\n\n![危险图片](javascript:alert)'} />)
    expect(screen.getByRole('img', { name: '外部图片' })).toHaveAttribute('src', 'https://example.com/cover.png')
    expect(screen.queryByRole('img', { name: '危险图片' })).toBeNull()
  })
})
