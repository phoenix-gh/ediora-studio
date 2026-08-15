// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublishAccount } from '@/lib/api/publish-accounts'

const mocks = vi.hoisted(() => ({
  listPublishAccounts: vi.fn(),
}))

vi.mock('@/lib/api/publish-accounts', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/publish-accounts')>()
  return { ...original, listPublishAccounts: mocks.listPublishAccounts }
})

import { BulkImageActionDialog } from './BulkImageActionDialog'

const activeAccount: PublishAccount = {
  id: 'account-a',
  name: '账号 A',
  platform: 'wechat',
  positioning: 'AI 工具解读',
  audience: '开发者',
  tone: '清晰',
  topic_focus: ['AI'],
  taboo: [],
  word_range: {},
  image_style: 'editorial',
  cover_style: {
    palette: 'cool',
    rendering: 'hand-drawn',
    signature_motifs: ['grid'],
    negative: ['no logos'],
  },
  voice_samples: [],
  style_rules: [],
  app_id: '',
  app_secret: '',
  is_active: true,
  created_at: '2026-08-04T00:00:00Z',
}

const inactiveAccount: PublishAccount = {
  ...activeAccount,
  id: 'account-off',
  name: '停用账号',
  is_active: false,
}

beforeEach(() => {
  mocks.listPublishAccounts.mockResolvedValue([activeAccount, inactiveAccount])
})

async function selectActiveAccount(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByLabelText('发布账号')
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name: /账号 A/ }))
}

describe('BulkImageActionDialog', () => {
  it('submits one illustration parameter set and clamps the per-article maximum to four', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <BulkImageActionDialog
        open
        mode="illustrations"
        selectedCount={2}
        running={false}
        progress={{ completed: 0, total: 2 }}
        failures={[]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.getByText('为已选 2 篇草稿统一设置参数。')).toBeInTheDocument()
    expect(screen.queryByText(/文章主版本/)).not.toBeInTheDocument()
    expect(await screen.findByLabelText('发布账号')).toHaveTextContent('（选择账号）')
    await selectActiveAccount(user)
    expect(screen.queryByText('停用账号')).not.toBeInTheDocument()
    const maxImages = screen.getByLabelText('每篇最多插图')
    fireEvent.change(maxImages, { target: { value: '8' } })
    await user.type(screen.getByLabelText('额外指令'), '解释结构')
    await user.click(screen.getByRole('button', { name: '开始批量插图' }))

    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'illustrations',
      accountId: 'account-a',
      note: '解释结构',
      maxImages: 4,
    })
  })

  it('adopts the selected account cover style for the shared cover request', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <BulkImageActionDialog
        open
        mode="cover"
        selectedCount={3}
        running={false}
        progress={{ completed: 0, total: 3 }}
        failures={[]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    )

    await selectActiveAccount(user)
    await user.click(screen.getByRole('button', { name: '开始批量封面' }))

    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'cover',
      accountId: 'account-a',
      note: '',
      coverStyle: {
        palette: 'cool',
        rendering: 'hand-drawn',
        signature_motifs: ['grid'],
        negative: ['no logos'],
      },
    })
  })

  it('shows progress and failures and cannot close or resubmit while running', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSubmit = vi.fn()
    render(
      <BulkImageActionDialog
        open
        mode="cover"
        selectedCount={12}
        running
        progress={{ completed: 3, total: 12 }}
        failures={[{ title: '失败草稿', reason: '任务提交失败' }]}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.getByText('3 / 12')).toBeInTheDocument()
    expect(screen.getByText('失败草稿')).toBeInTheDocument()
    expect(screen.getByText(/任务提交失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始批量封面' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(onClose).not.toHaveBeenCalled())
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
