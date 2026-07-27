// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Sidebar } from '@/components/features/Sidebar'
import { metadata } from '@/app/layout'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '--font-geist-sans' }),
  Geist_Mono: () => ({ variable: '--font-geist-mono' }),
}))

describe('product branding', () => {
  it('shows Ediora · 述策 in the sidebar', () => {
    render(<Sidebar />)

    expect(screen.queryByText('Ediora · 述策')).not.toBeNull()
  })

  it('uses the approved browser title', () => {
    expect(metadata.title).toBe('Ediora · 述策 — AI 内容工作台')
  })
})
