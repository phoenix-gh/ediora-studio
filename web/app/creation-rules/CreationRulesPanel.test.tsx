// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DailyCreationRule } from '@/lib/api/creation-rules'
import { CreationRulesPanel } from './CreationRulesPanel'

const pausedRule: DailyCreationRule = {
  id: 1,
  name: '暂停中的每日规则',
  prompt: '暂停自动调度，但允许用户手动执行。',
  asset_type: 'article',
  directory: '产品实验',
  directories: ['产品实验'],
  output_type: 'x_short_post',
  target_count: 1,
  execution_mode: 'recurring',
  scheduled_date: null,
  scheduled_time: '09:00',
  timezone: 'Asia/Shanghai',
  lookback_days: 7,
  delivery_mode: 'drafts',
  account_id: null,
  instructions: '',
  skill_mode: 'auto',
  skill_name: null,
  enabled: false,
  last_run_at: null,
  next_run_at: null,
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
}

describe('CreationRulesPanel', () => {
  it('keeps manual execution available for a paused rule', () => {
    const onRun = vi.fn()

    render(
      <CreationRulesPanel
        rules={[pausedRule]}
        runs={[]}
        activeRuleIds={new Set()}
        onCreate={vi.fn()}
        onRun={onRun}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    const runButton = screen.getByRole('button', { name: '立即执行' })
    expect(runButton).toBeEnabled()

    fireEvent.click(runButton)
    expect(onRun).toHaveBeenCalledWith(pausedRule)
  })
})
