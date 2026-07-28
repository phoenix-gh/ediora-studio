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
    expect(assetsLink.querySelector('span')).toHaveClass('sidebar-compact-label')
  })

  it('uses the inclusive 1024px compact breakpoint for every visually-hidden sidebar label', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'components/features/Sidebar.tsx'), 'utf8')
    const globalsSource = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')
    const compactMediaStart = globalsSource.indexOf('@media (max-width: 1024px)')
    const compactMediaEnd = globalsSource.indexOf('\n\n.dark', compactMediaStart)
    const compactMedia = globalsSource.slice(compactMediaStart, compactMediaEnd)

    expect(sidebarSource.match(/sidebar-compact-label/g)).toHaveLength(5)
    expect(sidebarSource).toContain('sidebar-compact-header')
    expect(sidebarSource).not.toMatch(/max-(?:lg|\[1024px\])/)
    expect(compactMedia).toContain('.sidebar-compact-label')
    expect(compactMedia).toContain('.sidebar-compact-header')
    expect(compactMedia).toContain('clip: rect(0, 0, 0, 0)')
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
