// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { XCredentialPool } from '@/lib/api/x-accounts'
import {
  createXCredentialAccount,
  deleteXCredentialAccount,
  listXCredentialAccounts,
  patchXCredentialAccount,
  testXCredentialAccount,
} from '@/lib/api/x-accounts'

import { XCredentialAccountsCard } from './XCredentialAccountsCard'

vi.mock('@/lib/api/x-accounts', () => ({
  listXCredentialAccounts: vi.fn(),
  createXCredentialAccount: vi.fn(),
  patchXCredentialAccount: vi.fn(),
  deleteXCredentialAccount: vi.fn(),
  testXCredentialAccount: vi.fn(),
}))

const poolFixture: XCredentialPool = {
  accounts: [{
    id: 7,
    name: '采集账号 A',
    enabled: true,
    auth_token_preview: '…auth',
    ct0_preview: '…csrf',
    test_status: 'available',
    last_tested_at: '2026-07-25T13:00:00Z',
    last_test_error: '',
    created_at: '2026-07-25T12:00:00Z',
    updated_at: '2026-07-25T13:00:00Z',
  }],
  external_sessions: ['twitter.json'],
  managed_enabled: 1,
  total_accounts: 2,
  available_accounts: 2,
}

const emptyPool: XCredentialPool = {
  accounts: [],
  external_sessions: [],
  managed_enabled: 0,
  total_accounts: 0,
  available_accounts: 0,
}

const twoAccountPool: XCredentialPool = {
  ...poolFixture,
  accounts: [
    poolFixture.accounts[0],
    { ...poolFixture.accounts[0], id: 8, name: '采集账号 B' },
  ],
  managed_enabled: 2,
  total_accounts: 3,
}

function renderLoaded(pool = poolFixture) {
  vi.mocked(listXCredentialAccounts).mockResolvedValue(pool)
  return render(<XCredentialAccountsCard />)
}

async function openAddDialog() {
  fireEvent.click(await screen.findByRole('button', { name: '添加账号' }))
  await screen.findByRole('dialog', { name: '添加采集账号' })
}

async function fillCredentialForm({
  name = '采集账号 A',
  authToken = 'secret-auth',
  ct0 = 'secret-csrf',
}: { name?: string; authToken?: string; ct0?: string } = {}) {
  fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: name } })
  if (authToken) fireEvent.change(screen.getByLabelText('auth_token'), { target: { value: authToken } })
  if (ct0) fireEvent.change(screen.getByLabelText('ct0'), { target: { value: ct0 } })
}

describe('XCredentialAccountsCard', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders pool counts and masked account state', async () => {
    renderLoaded()

    expect(await screen.findByText('采集账号 A')).not.toBeNull()
    expect(screen.getByText(/auth_token：…auth/)).not.toBeNull()
    expect(screen.getByText('外部 session：1')).not.toBeNull()
    expect(screen.queryByText('secret-auth')).toBeNull()
    expect(screen.getByText('可用')).not.toBeNull()
  })

  it('creates an account with a paired credential payload and clears raw inputs', async () => {
    vi.mocked(createXCredentialAccount).mockResolvedValue(poolFixture)
    renderLoaded(emptyPool)

    await openAddDialog()
    await fillCredentialForm()
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }))

    await waitFor(() => expect(createXCredentialAccount).toHaveBeenCalledWith({
      name: '采集账号 A',
      auth_token: 'secret-auth',
      ct0: 'secret-csrf',
      enabled: true,
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await openAddDialog()
    expect((screen.getByLabelText('auth_token') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('ct0') as HTMLInputElement).value).toBe('')
  })

  it('rejects a one-field credential update without calling the API', async () => {
    renderLoaded(emptyPool)

    await openAddDialog()
    await fillCredentialForm({ authToken: 'secret-auth', ct0: '' })

    expect((screen.getByRole('button', { name: '保存账号' }) as HTMLButtonElement).disabled).toBe(true)
    expect(createXCredentialAccount).not.toHaveBeenCalled()
  })

  it('requires both credentials when creating an account', async () => {
    renderLoaded(emptyPool)

    await openAddDialog()
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '采集账号 A' } })

    expect((screen.getByRole('button', { name: '保存账号' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('rejects whitespace-only credentials when creating an account', async () => {
    renderLoaded(emptyPool)

    await openAddDialog()
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '采集账号 A' } })
    fireEvent.change(screen.getByLabelText('auth_token'), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText('ct0'), { target: { value: '  ' } })

    expect((screen.getByRole('button', { name: '保存账号' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('distinguishes create requirements from edit credential retention', async () => {
    renderLoaded(emptyPool)

    await openAddDialog()

    expect(screen.getByText('新增账号必须填写 auth_token 和 ct0；编辑时留空可保留已有凭据。')).not.toBeNull()
  })

  it('edits account metadata while keeping credential fields blank', async () => {
    vi.mocked(patchXCredentialAccount).mockResolvedValue(poolFixture)
    renderLoaded()

    fireEvent.click(await screen.findByRole('button', { name: '编辑采集账号 A' }))
    await screen.findByRole('dialog', { name: '编辑采集账号' })

    expect((screen.getByLabelText('auth_token') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('ct0') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('账号名称'), { target: { value: '采集账号 A 更新' } })
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }))

    await waitFor(() => expect(patchXCredentialAccount).toHaveBeenCalledWith(7, {
      name: '采集账号 A 更新',
      enabled: true,
    }))
  })

  it('enables and disables an account independently', async () => {
    vi.mocked(patchXCredentialAccount).mockResolvedValue({
      ...poolFixture,
      accounts: [{ ...poolFixture.accounts[0], enabled: false }],
    })
    renderLoaded()

    fireEvent.click(await screen.findByRole('switch', { name: '启用采集账号 A' }))

    await waitFor(() => expect(patchXCredentialAccount).toHaveBeenCalledWith(7, { enabled: false }))
  })

  it('shows test progress and refreshes the returned test result', async () => {
    let resolveTest: (pool: XCredentialPool) => void = () => {}
    vi.mocked(testXCredentialAccount).mockImplementation(() => new Promise(resolve => { resolveTest = resolve }))
    renderLoaded()

    fireEvent.click(await screen.findByRole('button', { name: '测试采集账号 A' }))
    expect((screen.getByRole('button', { name: '测试中…' }) as HTMLButtonElement).disabled).toBe(true)

    resolveTest({
      ...poolFixture,
      accounts: [{ ...poolFixture.accounts[0], test_status: 'expired' }],
      available_accounts: 1,
    })

    expect(await screen.findByText('已失效')).not.toBeNull()
  })

  it('globally locks account actions while a cross-account mutation is pending', async () => {
    let resolveTest: (pool: XCredentialPool) => void = () => {}
    vi.mocked(testXCredentialAccount).mockImplementation(() => new Promise(resolve => { resolveTest = resolve }))
    renderLoaded(twoAccountPool)

    fireEvent.click(await screen.findByRole('button', { name: '测试采集账号 A' }))

    expect((document.querySelector('button[data-slot="dialog-trigger"]') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '编辑采集账号 B' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '测试采集账号 B' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '删除采集账号 B' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('switch', { name: '启用采集账号 B' }).hasAttribute('data-disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '测试采集账号 B' }))
    expect(testXCredentialAccount).toHaveBeenCalledTimes(1)

    resolveTest(twoAccountPool)
    await waitFor(() => expect((screen.getByRole('button', { name: '测试采集账号 B' }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('locks the add trigger while a create save with no acting id is pending', async () => {
    vi.mocked(createXCredentialAccount).mockImplementation(() => new Promise(() => {}))
    renderLoaded(emptyPool)

    await openAddDialog()
    await fillCredentialForm()
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }))

    expect((document.querySelector('button[data-slot="dialog-trigger"]') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存账号' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('requires AlertDialog confirmation before deleting an account', async () => {
    vi.mocked(deleteXCredentialAccount).mockResolvedValue(emptyPool)
    renderLoaded()

    fireEvent.click(await screen.findByRole('button', { name: '删除采集账号 A' }))
    await screen.findByRole('alertdialog', { name: '删除采集账号' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(deleteXCredentialAccount).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除采集账号 A' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deleteXCredentialAccount).toHaveBeenCalledWith(7))
  })

  it('shows a cleaned API error without echoing credentials', async () => {
    vi.mocked(createXCredentialAccount).mockRejectedValue(new Error('凭据 secret-auth 已失效'))
    renderLoaded(emptyPool)

    await openAddDialog()
    await fillCredentialForm()
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }))

    expect(await screen.findByText(/保存账号失败/)).not.toBeNull()
    expect(screen.queryByText(/secret-auth/)).toBeNull()
  })

  it('clears a generic action error when a later action begins and succeeds', async () => {
    let resolveRetry: (pool: XCredentialPool) => void = () => {}
    vi.mocked(testXCredentialAccount)
      .mockRejectedValueOnce(new Error('临时测试失败'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve }))
    renderLoaded()

    fireEvent.click(await screen.findByRole('button', { name: '测试采集账号 A' }))
    expect(await screen.findByText('测试账号失败：临时测试失败')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '测试采集账号 A' }))
    await waitFor(() => expect(screen.queryByText('测试账号失败：临时测试失败')).toBeNull())
    resolveRetry(poolFixture)

    await waitFor(() => expect(screen.queryByText('测试账号失败：临时测试失败')).toBeNull())
  })

  it('keeps a failed delete dialog open with a retryable in-dialog error', async () => {
    vi.mocked(deleteXCredentialAccount).mockRejectedValue(new Error('删除服务不可用'))
    renderLoaded()

    fireEvent.click(await screen.findByRole('button', { name: '删除采集账号 A' }))
    const dialog = await screen.findByRole('alertdialog', { name: '删除采集账号' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))

    expect(await within(dialog).findByText('删除账号失败：删除服务不可用')).not.toBeNull()
    expect((within(dialog).getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
