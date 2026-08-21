// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WechatAuthState } from '@/lib/api/wechat'
import { AuthPill, WechatToolbar } from './WechatClient'

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

describe('WechatToolbar layout', () => {
  const toolbarProps = {
    filteredCount: 3,
    auth: loggedOut,
    collecting: false,
    collect: null,
    accounts: ['测试公众号'],
    selectedAccount: null,
    search: '',
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onManage: vi.fn(),
    onCollect: vi.fn(),
    onSelectAccount: vi.fn(),
    onSearch: vi.fn(),
  }

  it('收拢宽屏侧栏的操作并保持两行结构', () => {
    render(<WechatToolbar {...toolbarProps} useSidePanel />)

    const titleRow = screen.getByTestId('wechat-toolbar-title-row')
    const actions = screen.getByTestId('wechat-toolbar-actions')
    const loginButton = screen.getByRole('button', { name: '扫码登录公众平台' })

    expect(titleRow).toContainElement(loginButton)
    expect(actions).toHaveClass('w-full')
    expect(actions).not.toContainElement(loginButton)
    expect(screen.getByRole('button', { name: '订阅管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '一键采集' })).toBeInTheDocument()
    expect(screen.queryByText('订阅管理')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索标题/公众号')).toHaveClass('w-full')
  })

  it('保留普通宽度下的文字操作', () => {
    render(<WechatToolbar {...toolbarProps} useSidePanel={false} />)

    expect(screen.getByText('订阅管理')).toBeInTheDocument()
    expect(screen.getByText('一键采集')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索标题/公众号')).toHaveClass('w-40')
  })
})
