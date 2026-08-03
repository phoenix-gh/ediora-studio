// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listCreationRules: vi.fn(), listCreationRuns: vi.fn(), listDirectories: vi.fn(), getTodayPlan: vi.fn() }))
vi.mock('@/lib/api/daily-plan', async original => ({ ...await original<typeof import('@/lib/api/daily-plan')>(), listCreationRules: mocks.listCreationRules, listCreationRuns: mocks.listCreationRuns, getTodayPlan: mocks.getTodayPlan }))
vi.mock('@/lib/api/assets', () => ({ listCreativeAssetDirectories: mocks.listDirectories }))

import { DailyPlanClient } from './DailyPlanClient'

beforeEach(() => {
  mocks.listCreationRules.mockResolvedValue([])
  mocks.listCreationRuns.mockResolvedValue([])
  mocks.listDirectories.mockResolvedValue([])
  mocks.getTodayPlan.mockResolvedValue({ plan: null })
})

it('renders creation runs above rules while preserving the existing planner', async () => {
  render(<DailyPlanClient initialPlan={null} />)
  await waitFor(() => expect(mocks.listCreationRuns).toHaveBeenCalled())
  const runs = screen.getByRole('heading', { name: '今日创作任务' })
  const rules = screen.getByRole('heading', { name: '创作规则' })
  expect(runs.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByText('今天还没有计划。每天 8:00 自动生成，也可以现在手动生成。')).toBeInTheDocument()
})
