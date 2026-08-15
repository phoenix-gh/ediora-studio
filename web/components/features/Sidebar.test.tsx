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

  it('uses the shared application header height for the brand area', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('app-brand-header')).toHaveClass('h-[var(--app-header-height)]')
    expect(screen.getByTestId('app-brand-header')).toHaveAttribute('data-slot', 'app-brand-header')
  })

  it('keeps navigation link names available in compact mode', () => {
    render(<Sidebar />)

    const assetsLink = screen.getByRole('link', { name: '创作资产' })
    expect(assetsLink).toHaveTextContent('创作资产')
    expect(assetsLink.querySelector('span')).toHaveClass('sidebar-compact-label')
  })

  it('adds text video under creation navigation', () => {
    render(<Sidebar />)

    expect(screen.getByRole('link', { name: '文字视频' })).toHaveAttribute('href', '/text-video')
  })

  it('places the intelligence center immediately above the task board', () => {
    render(<Sidebar />)

    const nav = screen.getByRole('navigation', { name: '主导航' })
    const labels = Array.from(nav.querySelectorAll('a')).map((link) => link.textContent?.trim())

    expect(labels).not.toContain('情报站')
    expect(labels).toContain('情报中心')
    expect(labels.indexOf('情报中心')).toBe(labels.indexOf('任务看板') - 1)
  })

  it('uses the inclusive 1024px compact breakpoint for every visually-hidden sidebar label', () => {
    const sidebarSource = readFileSync(resolve(process.cwd(), 'components/features/Sidebar.tsx'), 'utf8')
    const globalsSource = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')
    const compactMediaStart = globalsSource.indexOf('@media (max-width: 1024px)')
    const compactMediaEnd = globalsSource.indexOf('\n\n.dark', compactMediaStart)
    const compactMedia = globalsSource.slice(compactMediaStart, compactMediaEnd)

    expect(sidebarSource.match(/sidebar-compact-label/g)).toHaveLength(5)
    expect(sidebarSource).toContain('sidebar-compact-header')
    expect(sidebarSource.match(/sidebar-compact-link/g)).toHaveLength(2)
    expect(sidebarSource).not.toMatch(/max-(?:lg|\[1024px\])/)
    expect(compactMedia).toContain('.sidebar-compact-label')
    expect(compactMedia).toContain('.sidebar-compact-header')
    expect(compactMedia).toContain('.sidebar-compact-header > div')
    expect(compactMedia).toContain('.sidebar-compact-link')
    expect(compactMedia).toContain('clip: rect(0, 0, 0, 0)')
    expect(compactMedia).toMatch(/\.sidebar-compact-header > div\s*{[^}]*justify-content:\s*center/)
    expect(compactMedia).toMatch(/\.sidebar-compact-link\s*{[^}]*justify-content:\s*center/)
    expect(compactMedia).toMatch(/\.sidebar-compact-link\s*{[^}]*padding-inline:\s*0/)
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
