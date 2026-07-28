// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
    expect(assetsLink.querySelector('span')).toHaveClass('max-[1024px]:sr-only')
  })

  it('uses the inclusive 1024px compact breakpoint for every visually-hidden sidebar label', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'components/features/Sidebar.tsx'), 'utf8')
    const globalsSource = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')

    expect(sidebarSource.match(/max-\[1024px\]:sr-only/g)).toHaveLength(5)
    expect(sidebarSource).not.toContain('max-lg:sr-only')
    expect(globalsSource).toContain('@media (max-width: 1024px)')
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
