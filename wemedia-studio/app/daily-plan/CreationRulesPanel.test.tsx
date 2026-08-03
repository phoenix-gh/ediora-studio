// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { CreationRulesPanel } from './CreationRulesPanel'

const rule = {
  id: 1, name: '产品短帖', asset_type: 'article' as const, directory: '产品实验',
  output_type: 'x_short_post' as const, target_count: 3,
  execution_mode: 'recurring' as const, scheduled_date: null,
  scheduled_time: '09:30', timezone: 'Asia/Shanghai', lookback_days: 5,
  delivery_mode: 'drafts' as const, account_id: null, instructions: '', enabled: true,
  created_at: '', updated_at: '',
}

it('keeps run now primary and exposes edit pause and delete actions', () => {
  const onRun = vi.fn()
  const onToggle = vi.fn()
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  render(<CreationRulesPanel rules={[rule]} activeRuleIds={new Set()} onCreate={() => {}} onRun={onRun} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />)
  fireEvent.click(screen.getByRole('button', { name: '立即执行' }))
  fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  fireEvent.click(screen.getByRole('button', { name: '删除' }))
  expect(onRun).toHaveBeenCalledWith(rule)
  expect(onToggle).toHaveBeenCalledWith(rule)
  expect(onEdit).toHaveBeenCalledWith(rule)
  expect(onDelete).toHaveBeenCalledWith(rule)
})
