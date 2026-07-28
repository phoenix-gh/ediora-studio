// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSection } from './AppearanceSection'

const themeState = vi.hoisted(() => ({
  theme: 'system',
  setTheme: vi.fn(),
}))

vi.mock('next-themes', () => ({
  useTheme: () => themeState,
}))

describe('AppearanceSection', () => {
  beforeEach(() => {
    themeState.theme = 'system'
    themeState.setTheme.mockReset()
  })

  afterEach(cleanup)

  it('offers system, light, and dark appearance options', () => {
    render(<AppearanceSection />)

    expect(screen.getByRole('button', { name: '跟随系统' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '浅色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '深色' })).toBeInTheDocument()
  })

  it('changes the theme to light', () => {
    render(<AppearanceSection />)

    fireEvent.click(screen.getByRole('button', { name: '浅色' }))

    expect(themeState.setTheme).toHaveBeenCalledWith('light')
  })

  it('marks the current theme as pressed', () => {
    themeState.theme = 'dark'

    render(<AppearanceSection />)

    expect(screen.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'false')
  })
})
