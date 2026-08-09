// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ArticleReaderPanel, type ReaderMeta } from './ArticleReader'

const meta: ReaderMeta = {
  title: '公众号文章',
  url: 'https://mp.weixin.qq.com/s/example',
  content: '<p style="color: rgba(0,0,0,.9)">需要保持可读的正文</p>',
}

afterEach(cleanup)

describe('ArticleReader content theme', () => {
  it('renders paper content on a light canvas without dark prose inversion', () => {
    const { container } = render(
      <ArticleReaderPanel
        open
        onClose={vi.fn()}
        meta={meta}
        contentTheme="paper"
      />,
    )

    const article = container.querySelector('article')
    expect(article).not.toBeNull()
    expect(article?.className).toContain('bg-white')
    expect(article?.className).toContain('text-zinc-900')
    expect(article?.className).not.toContain('dark:prose-invert')
    expect(article?.querySelector('p')?.getAttribute('style')).toContain(
      'color: rgba(0,0,0,.9)',
    )
  })

  it('keeps adaptive dark prose behavior by default', () => {
    const { container } = render(
      <ArticleReaderPanel open onClose={vi.fn()} meta={meta} />,
    )

    expect(container.querySelector('article')?.className).toContain(
      'dark:prose-invert',
    )
  })

  it('shows a source-specific empty content message', () => {
    render(
      <ArticleReaderPanel
        open
        onClose={vi.fn()}
        meta={{ ...meta, content: '' }}
        emptyContentMessage="正文尚未采集成功"
      />,
    )
    expect(screen.getByText(/正文尚未采集成功/)).toBeTruthy()
  })
})
