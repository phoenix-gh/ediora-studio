// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WechatAuthState } from '@/lib/api/wechat'
import { AuthPill } from './WechatClient'

const loggedOut: WechatAuthState = {
  logged_in: false,
  nickname: '',
  avatar: '',
  expires_at: null,
  expired: false,
}

function loggedIn(expiresAt: string): WechatAuthState {
  return {
    logged_in: true,
    nickname: '测试账号',
    avatar: '',
    expires_at: expiresAt,
    expired: false,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-30T00:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AuthPill remaining time', () => {
  it('uses the current time immediately when login state changes', () => {
    const { rerender } = render(
      <AuthPill state={loggedOut} onLogin={vi.fn()} onLogout={vi.fn()} />,
    )

    vi.setSystemTime(new Date('2026-07-30T00:05:00Z'))
    rerender(
      <AuthPill
        state={loggedIn('2026-07-30T00:15:00Z')}
        onLogin={vi.fn()}
        onLogout={vi.fn()}
      />,
    )

    expect(screen.getByText(/剩余 10min/)).toBeTruthy()
  })

  it('uses the current time immediately when the expiry changes', () => {
    const { rerender } = render(
      <AuthPill
        state={loggedIn('2026-07-30T00:10:00Z')}
        onLogin={vi.fn()}
        onLogout={vi.fn()}
      />,
    )
    expect(screen.getByText(/剩余 10min/)).toBeTruthy()

    vi.setSystemTime(new Date('2026-07-30T00:02:00Z'))
    rerender(
      <AuthPill
        state={loggedIn('2026-07-30T00:22:00Z')}
        onLogin={vi.fn()}
        onLogout={vi.fn()}
      />,
    )

    expect(screen.getByText(/剩余 20min/)).toBeTruthy()
  })
})
