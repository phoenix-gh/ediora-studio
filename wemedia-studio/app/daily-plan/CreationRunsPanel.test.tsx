// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { CreationRunsPanel } from './CreationRunsPanel'

it('renders partial progress, exclusions, and draft links', () => {
  render(<CreationRunsPanel runs={[{
    id: 8, rule_id: 1, content_job_id: 2, scheduled_for: '2026-08-03T01:00:00Z',
    trigger_kind: 'explicit', status: 'partial', requested_count: 3, created_count: 2,
    detail: { excluded: [{ asset_id: 4, reason: '近期角度重复' }], outputs: [{ draft_id: 19 }] },
    rule: { name: '产品短帖', directory: '产品实验', directories: ['产品实验', '增长资料'] }, created_at: '',
  }]} />)
  expect(screen.getByText('2 / 3')).toBeInTheDocument()
  expect(screen.getByText('近期角度重复')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '草稿 #19' })).toHaveAttribute('href', '/drafts')
  expect(screen.getByText('产品实验、增长资料')).toBeInTheDocument()
})

it('renders the bounded Agent skill, references, tool audit, and completion', () => {
  render(<CreationRunsPanel runs={[{
    id: 18, rule_id: 1, content_job_id: 22, scheduled_for: '2026-08-04T01:00:00Z',
    trigger_kind: 'schedule', status: 'succeeded', requested_count: 1, created_count: 1,
    detail: { outputs: [{ draft_id: 192 }] },
    rule: { name: '搞钱短帖', directory: '搞钱副业', directories: ['搞钱副业'] },
    created_at: '',
    agent_execution: {
      status: 'succeeded', phase: 'complete', skill_name: 'human-social-copy',
      skill_activation: 'automatic',
      loaded_references: [{ path: 'references/finance-writing.md', bytes: 321 }],
      tools: [
        {
          tool_name: 'save_daily_creation_outputs', status: 'succeeded',
          auto_approved: true, occurred_at: '2026-08-04T01:02:00Z', error: '',
        },
        {
          tool_name: 'save_external_item', status: 'uncertain',
          auto_approved: true, occurred_at: '2026-08-04T01:01:00Z',
          error: 'prior side-effecting tool outcome is unknown',
        },
      ],
      self_validation: { passed: true, summary: 'checked' },
      completion: {
        toolName: 'save_daily_creation_outputs', toolCallId: 'save-1',
        runId: 18, createdCount: 1, outputIds: [192], usageIds: [292],
      },
    },
  }]} />)

  expect(screen.getByText('human-social-copy')).toBeInTheDocument()
  expect(screen.getByText('自动触发')).toBeInTheDocument()
  expect(screen.getByText('references/finance-writing.md')).toBeInTheDocument()
  expect(screen.getByText('save_daily_creation_outputs')).toBeInTheDocument()
  expect(screen.getAllByText('自动批准')).toHaveLength(2)
  expect(screen.getByText('prior side-effecting tool outcome is unknown')).toBeInTheDocument()
  expect(screen.getByText('已落库 1 条')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '草稿 #192' })).toHaveAttribute('href', '/drafts')
})
