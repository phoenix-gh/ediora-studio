// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listCreationRules: vi.fn(), listCreationRuns: vi.fn(), listDirectories: vi.fn(), listSkills: vi.fn(), listAccounts: vi.fn(), getTodayPlan: vi.fn() }))
vi.mock('@/lib/api/daily-plan', async original => ({ ...await original<typeof import('@/lib/api/daily-plan')>(), listCreationRules: mocks.listCreationRules, listCreationRuns: mocks.listCreationRuns, getTodayPlan: mocks.getTodayPlan }))
vi.mock('@/lib/api/assets', () => ({ listCreativeAssetDirectories: mocks.listDirectories }))
vi.mock('@/lib/api/chat', () => ({ listChatSkills: mocks.listSkills }))
vi.mock('@/lib/api/publish-accounts', () => ({ listPublishAccounts: mocks.listAccounts }))

import { DailyPlanClient } from './DailyPlanClient'

beforeEach(() => {
  mocks.listCreationRules.mockResolvedValue([])
  mocks.listCreationRuns.mockResolvedValue([])
  mocks.listDirectories.mockResolvedValue([])
  mocks.listSkills.mockResolvedValue([])
  mocks.listAccounts.mockResolvedValue([])
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

it('loads enabled Skills and offers them in the creation rule dialog', async () => {
  mocks.listDirectories.mockImplementation(async (assetType: string) => assetType === 'article' ? [
    { id: 1, name: '搞钱副业', asset_type: 'article' },
  ] : [])
  mocks.listSkills.mockResolvedValue([
    { name: 'human-social-copy', description: '中文社媒写作', version: '1.0.0' },
  ])

  render(<DailyPlanClient initialPlan={null} />)
  await waitFor(() => expect(mocks.listSkills).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '新建规则' }))
  fireEvent.click(screen.getByRole('radio', { name: '手动指定' }))

  expect(screen.getByRole('option', { name: /human-social-copy/ })).toBeInTheDocument()
})
