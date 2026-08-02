// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { XSubscription } from '@/lib/api/x'

import { XSubscriptionRow, type XSubscriptionRowProps } from './XSubscriptionRow'

const timeline: XSubscription = {
  id: 1,
  url: 'https://x.com/openai',
  label: 'OpenAI 官方账号',
  kind: 'timeline',
  enabled: true,
  raw_query: '',
  min_faves: 0,
  min_retweets: 0,
  lang: '',
  days: 7,
  extra_terms: '',
  sort: 'Latest',
  max_results: 50,
  notify_new_posts: true,
  last_collected_at: '2026-08-02T12:00:00Z',
  last_error: '',
  added_at: '2026-08-01T12:00:00Z',
  post_count: 42,
}

const callbacks = () => ({
  onToggle: vi.fn(),
  onCollect: vi.fn(),
  onEdit: vi.fn(),
  onToggleNotify: vi.fn(),
  onConfigureIngestion: vi.fn(),
  onScreen: vi.fn(),
  onBackfill: vi.fn(),
  onDelete: vi.fn(),
})

function renderRow(overrides: Partial<XSubscriptionRowProps> = {}) {
  const actions = callbacks()
  render(
    <XSubscriptionRow
      subscription={timeline}
      enabledRuleCount={2}
      busy={false}
      collecting={false}
      screening={false}
      {...actions}
      {...overrides}
    />,
  )
  return actions
}

afterEach(() => cleanup())

describe('XSubscriptionRow', () => {
  it('keeps collection visible and moves secondary timeline actions into the menu', async () => {
    const actions = renderRow()

    expect(screen.getByRole('button', { name: '采集' })).toBeVisible()
    expect(screen.getByRole('switch', { name: '启用订阅：OpenAI 官方账号' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: '编辑订阅' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更多操作：OpenAI 官方账号' }))

    expect(await screen.findByRole('menuitem', { name: '编辑订阅' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '关闭即时响应' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '配置素材入库' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'AI 筛选入库' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '回溯采集' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '删除订阅' })).toHaveAttribute('data-variant', 'destructive')

    fireEvent.click(screen.getByRole('button', { name: '采集' }))
    expect(actions.onCollect).toHaveBeenCalledWith(timeline)
  })

  it('omits timeline-only actions for search subscriptions', async () => {
    renderRow({ subscription: { ...timeline, kind: 'search', url: null, raw_query: 'AI lang:zh' } })

    fireEvent.click(screen.getByRole('button', { name: '更多操作：OpenAI 官方账号' }))

    expect(await screen.findByRole('menuitem', { name: '编辑订阅' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: /即时响应/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '回溯采集' })).toBeNull()
  })

  it('disables the fixed controls while busy', () => {
    renderRow({ busy: true })

    expect(screen.getByRole('switch', { name: '启用订阅：OpenAI 官方账号' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '采集' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '更多操作：OpenAI 官方账号' })).toBeDisabled()
  })

  it('marks AI screening as busy and prevents a duplicate action', async () => {
    renderRow({ screening: true })
    fireEvent.click(screen.getByRole('button', { name: '更多操作：OpenAI 官方账号' }))

    expect(await screen.findByRole('menuitem', { name: 'AI 筛选中' })).toHaveAttribute('data-disabled')
  })

  it('cancels inline editing with Escape without committing', () => {
    const onCommitEdit = vi.fn()
    const onCancelEdit = vi.fn()
    renderRow({ editing: true, editValue: timeline.label, onCommitEdit, onCancelEdit })

    const propagated = fireEvent.keyDown(
      screen.getByRole('textbox', { name: `订阅名称：${timeline.label}` }),
      { key: 'Escape' },
    )

    expect(onCancelEdit).toHaveBeenCalledOnce()
    expect(onCommitEdit).not.toHaveBeenCalled()
    expect(propagated).toBe(false)
  })
})
