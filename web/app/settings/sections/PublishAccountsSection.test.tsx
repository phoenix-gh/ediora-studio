// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPublishAccount,
  deletePublishAccount,
  listPublishAccounts,
  updatePublishAccount,
  type PublishAccount,
} from '@/lib/api/publish-accounts'
import { getSettings, updateSettings, type AppSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'
import { toast } from 'sonner'

import { PublishAccountsSection } from './PublishAccountsSection'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

vi.mock('@/lib/api/publish-accounts', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/publish-accounts')>()
  return {
    ...original,
    createPublishAccount: vi.fn(),
    deletePublishAccount: vi.fn(),
    listPublishAccounts: vi.fn(),
    updatePublishAccount: vi.fn(),
  }
})

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, getSettings: vi.fn(), updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const account: PublishAccount = {
  id: 'writer',
  name: '技术作者',
  platform: 'x',
  positioning: '技术写作',
  audience: '工程师',
  tone: '克制',
  topic_focus: ['AI'],
  taboo: ['广告'],
  word_range: { posts_min: 8 },
  image_style: '',
  cover_style: {},
  voice_samples: ['范文'],
  style_rules: ['禁用感叹号'],
  app_id: '',
  app_secret: '',
  is_active: true,
  created_at: '2026-07-28T00:00:00Z',
}

describe('PublishAccountsSection', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings())
    vi.mocked(listPublishAccounts).mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('cancels deletion without a call and keeps a failed deletion retryable', async () => {
    vi.mocked(listPublishAccounts).mockResolvedValue([account])
    vi.mocked(deletePublishAccount)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    render(<PublishAccountsSection />)

    await screen.findByText('技术作者')
    fireEvent.click(screen.getByRole('button', { name: '删除 技术作者' }))
    expect(screen.getByRole('heading', { name: '删除发布账号？' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(deletePublishAccount).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除 技术作者' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deletePublishAccount).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('heading', { name: '删除发布账号？' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deletePublishAccount).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('技术作者')).not.toBeInTheDocument())
  })

  it('validates JSON and parses newline and divider fields when creating', async () => {
    vi.mocked(createPublishAccount).mockResolvedValue(account)
    render(<PublishAccountsSection />)

    await screen.findByRole('button', { name: '新增发布账号' })
    fireEvent.click(screen.getByRole('button', { name: '新增发布账号' }))
    fireEvent.change(screen.getByLabelText(/^ID/), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '技术作者' } })
    fireEvent.change(screen.getByLabelText(/字数范围/), { target: { value: '[' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(toast.error).toHaveBeenCalledWith('字数范围 JSON 格式错误')
    expect(createPublishAccount).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/字数范围/), {
      target: { value: '{"posts_min":8}' },
    })
    fireEvent.change(screen.getByLabelText(/每日配额/), {
      target: { value: '{"short":1}' },
    })
    fireEvent.change(screen.getByLabelText(/选题方向/), {
      target: { value: ' AI \n\nAgents ' },
    })
    fireEvent.change(screen.getByLabelText(/禁区/), {
      target: { value: ' 广告 \n营销' },
    })
    fireEvent.change(screen.getByLabelText(/声音范文/), {
      target: { value: '范文一\n\n---\n\n范文二' },
    })
    fireEvent.change(screen.getByLabelText(/账号专属硬规则/), {
      target: { value: ' 禁用感叹号 \n短句' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(createPublishAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'writer',
      name: '技术作者',
      topic_focus: ['AI', 'Agents'],
      taboo: ['广告', '营销'],
      word_range: { posts_min: 8 },
      voice_samples: ['范文一', '范文二'],
      style_rules: ['禁用感叹号', '短句'],
      is_active: true,
    })))
  })

  it('keeps the account id immutable in PATCH and toggles active with a focused patch', async () => {
    vi.mocked(listPublishAccounts).mockResolvedValue([account])
    vi.mocked(updatePublishAccount)
      .mockResolvedValueOnce({ ...account, name: '新名称' })
      .mockResolvedValueOnce({ ...account, is_active: false })
    render(<PublishAccountsSection />)

    await screen.findByText('技术作者')
    fireEvent.click(screen.getByRole('button', { name: '编辑 技术作者' }))
    expect(screen.getByLabelText(/^ID/)).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '新名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updatePublishAccount).toHaveBeenCalledTimes(1))
    const [, patch] = vi.mocked(updatePublishAccount).mock.calls[0]
    expect(patch).not.toHaveProperty('id')

    fireEvent.click(screen.getByRole('button', { name: '停用 新名称' }))
    await waitFor(() => expect(updatePublishAccount).toHaveBeenLastCalledWith('writer', {
      is_active: false,
    }))
  })

  it('locks the editor while saving, prevents duplicate submit and closes only after success', async () => {
    const pendingSave = deferred<PublishAccount>()
    vi.mocked(createPublishAccount).mockReturnValue(pendingSave.promise)
    render(<PublishAccountsSection />)

    await screen.findByRole('button', { name: '新增发布账号' })
    fireEvent.click(screen.getByRole('button', { name: '新增发布账号' }))
    fireEvent.change(screen.getByLabelText(/^ID/), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '技术作者' } })

    const saveButton = screen.getByRole('button', { name: '保存' })
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    await waitFor(() => expect(createPublishAccount).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText(/^ID/)).toBeDisabled()
    expect(screen.getByLabelText(/名称/)).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '平台' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('heading', { name: '新增发布账号' })).toBeInTheDocument()

    await act(async () => {
      pendingSave.resolve(account)
      await pendingSave.promise
    })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '新增发布账号' })).not.toBeInTheDocument())
  })

  it('keeps the same editor open and editable when saving fails', async () => {
    vi.mocked(createPublishAccount).mockRejectedValue(new Error('offline'))
    render(<PublishAccountsSection />)

    await screen.findByRole('button', { name: '新增发布账号' })
    fireEvent.click(screen.getByRole('button', { name: '新增发布账号' }))
    fireEvent.change(screen.getByLabelText(/^ID/), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '技术作者' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('保存失败：offline'))
    expect(screen.getByRole('heading', { name: '新增发布账号' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^ID/)).toHaveValue('writer')
    expect(screen.getByLabelText(/名称/)).toHaveValue('技术作者')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
  })

  it('keeps a later editor session when an older save resolves', async () => {
    const secondAccount = { ...account, id: 'editor', name: '编辑者' }
    const pendingSave = deferred<PublishAccount>()
    vi.mocked(listPublishAccounts).mockResolvedValue([account, secondAccount])
    vi.mocked(updatePublishAccount).mockReturnValue(pendingSave.promise)
    render(<PublishAccountsSection />)

    await screen.findByText('技术作者')
    fireEvent.click(screen.getByRole('button', { name: '编辑 技术作者' }))
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '技术作者 A' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updatePublishAccount).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '编辑 编辑者', hidden: true }))
    expect(screen.getByLabelText(/^ID/)).toHaveValue('editor')
    expect(screen.getByLabelText(/名称/)).toHaveValue('编辑者')

    await act(async () => {
      pendingSave.resolve({ ...account, name: '技术作者 A' })
      await pendingSave.promise
    })

    expect(screen.getByRole('heading', { name: '编辑发布账号' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^ID/)).toHaveValue('editor')
    expect(screen.getByLabelText(/名称/)).toHaveValue('编辑者')
  })

  it('makes loaded accounts usable while tunnel settings are still loading', async () => {
    const settingsRequest = deferred<AppSettings>()
    vi.mocked(listPublishAccounts).mockResolvedValue([account])
    vi.mocked(getSettings).mockReturnValue(settingsRequest.promise)

    render(<PublishAccountsSection />)

    expect(await screen.findByText('技术作者')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增发布账号' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存隧道配置' })).toBeDisabled()

    await act(async () => {
      settingsRequest.resolve(makeSettings({ wechat_tunnel_ssh_host: 'loaded.example.com' }))
      await settingsRequest.promise
    })

    await waitFor(() => expect(screen.getByRole('button', { name: '保存隧道配置' })).toBeEnabled())
    expect(screen.getByLabelText('SSH Host')).toHaveValue('loaded.example.com')
  })

  it('never saves placeholder tunnel defaults after a load failure and unlocks writes only after retry', async () => {
    const loadedSettings = makeSettings({
      wechat_tunnel_ssh_host: 'jump.example.com',
      wechat_tunnel_ssh_user: 'publisher',
    })
    vi.mocked(listPublishAccounts).mockResolvedValue([account])
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new Error('settings offline'))
      .mockResolvedValueOnce(loadedSettings)
    vi.mocked(updateSettings).mockResolvedValue(loadedSettings)

    render(<PublishAccountsSection />)

    expect(await screen.findByRole('alert', { name: '公众号发布隧道配置加载失败' }))
      .toHaveTextContent('公众号发布隧道配置加载失败，请稍后重试')
    const saveTunnelButton = screen.getByRole('button', { name: '保存隧道配置' })
    expect(saveTunnelButton).toBeDisabled()
    fireEvent.click(saveTunnelButton)
    expect(updateSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '重试加载隧道配置' }))
    await waitFor(() => expect(saveTunnelButton).toBeEnabled())
    expect(screen.getByLabelText('SSH Host')).toHaveValue('jump.example.com')

    fireEvent.change(screen.getByLabelText('SSH Host'), { target: { value: 'new-jump.example.com' } })
    fireEvent.click(saveTunnelButton)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      wechat_tunnel_ssh_host: 'new-jump.example.com',
      wechat_tunnel_ssh_user: 'publisher',
    })))
  })

  it('keeps loaded tunnel settings writable while account loading fails and retries accounts independently', async () => {
    vi.mocked(listPublishAccounts)
      .mockRejectedValueOnce(new Error('accounts offline'))
      .mockResolvedValueOnce([account])
    vi.mocked(getSettings).mockResolvedValue(makeSettings({
      wechat_tunnel_ssh_host: 'jump.example.com',
    }))

    render(<PublishAccountsSection />)

    await waitFor(() => expect(screen.getByRole('button', { name: '保存隧道配置' })).toBeEnabled())
    expect(screen.getByLabelText('SSH Host')).toHaveValue('jump.example.com')
    expect(screen.getByRole('alert', { name: '发布账号加载失败' }))
      .toHaveTextContent('发布账号加载失败，请稍后重试')
    expect(screen.getByRole('button', { name: '新增发布账号' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '重试加载发布账号' }))
    expect(await screen.findByText('技术作者')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增发布账号' })).toBeEnabled()
  })
})
