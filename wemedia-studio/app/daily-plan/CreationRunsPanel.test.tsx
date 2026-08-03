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
