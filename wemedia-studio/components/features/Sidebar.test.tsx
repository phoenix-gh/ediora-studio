// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/components/layout/AppShell'

import { Sidebar } from './Sidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/assets',
}))

describe('Sidebar in the app shell', () => {
  it('marks the current route and exposes the main navigation landmark', () => {
    render(<Sidebar />)

    expect(screen.getByRole('navigation', { name: '主导航' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '创作资产' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps navigation link names available in compact mode', () => {
    render(<Sidebar />)

    const assetsLink = screen.getByRole('link', { name: '创作资产' })
    expect(assetsLink).toHaveTextContent('创作资产')
    expect(assetsLink.querySelector('span')).toHaveClass('max-lg:sr-only')
  })

  it('renders one application content boundary', () => {
    render(
      <AppShell sidebar={<Sidebar />}>
        <div>页面内容</div>
      </AppShell>,
    )

    const main = screen.getByRole('main')
    expect(document.querySelectorAll('main')).toHaveLength(1)
    expect(main).toHaveAttribute('data-slot', 'app-content')
    expect(main).toHaveTextContent('页面内容')
  })
})
