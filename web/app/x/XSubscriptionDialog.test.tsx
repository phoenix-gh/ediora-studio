// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppSettings } from '@/lib/api/settings'
import type { XSubscription } from '@/lib/api/x'

const mocks = vi.hoisted(() => ({
  listCreativeAssetDirectories: vi.fn(),
  getSettings: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/api/assets', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/assets')>()
  return {
    ...original,
    listCreativeAssetDirectories: mocks.listCreativeAssetDirectories,
  }
})

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return {
    ...original,
    getSettings: mocks.getSettings,
  }
})

import { XSubscriptionDialog } from './XSubscriptionDialog'

const subscription: XSubscription = {
  id: 7,
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
  collect_interval_minutes: 15,
  intelligence_enabled: true,
  intelligence_enabled_at: '2026-08-01T12:00:00Z',
  llm_adapter_id: null,
  ingestion_directory_ids: [5],
  last_collected_at: null,
  last_error: '',
  added_at: '2026-08-01T12:00:00Z',
  post_count: 42,
}

const searchSubscription: XSubscription = {
  ...subscription,
  id: 8,
  url: null,
  label: 'AI 研究动态',
  kind: 'search',
  raw_query: '(AI OR 大模型) lang:zh',
  max_results: 80,
}

const callbacks = () => ({
  onOpenChange: vi.fn(),
  onAdd: vi.fn().mockResolvedValue(undefined),
  onSave: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
  onCollect: vi.fn().mockResolvedValue(undefined),
  onBackfill: vi.fn().mockResolvedValue(undefined),
  onIngestExisting: vi.fn().mockResolvedValue(undefined),
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('XSubscriptionDialog', () => {
  it('edits one subscription and confirms deletion inside the same dialog', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([])
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="edit"
        subscription={subscription}
        {...actions}
      />,
    )

    expect(screen.getByRole('dialog', { name: '编辑 X 订阅 · OpenAI 官方账号' })).toBeVisible()
    expect(screen.getByDisplayValue('OpenAI 官方账号')).toBeVisible()
    expect(screen.getByDisplayValue('https://x.com/openai')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '删除订阅' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '删除订阅' }))
    expect(screen.getByText('删除后关联帖子也会被清除，确定继续吗？')).toBeVisible()
    expect(actions.onDelete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(actions.onDelete).toHaveBeenCalledWith(subscription)
    })
  })

  it('renders create mode without showing a subscription list or management title', () => {
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="create"
        subscription={null}
        {...actions}
      />,
    )

    expect(screen.getByRole('dialog', { name: '新增 X 订阅' })).toBeVisible()
    expect(screen.queryByText('已订阅')).toBeNull()
    expect(screen.getByRole('button', { name: '添加时间线订阅' })).toBeVisible()
  })

  it('loads and saves search-specific fields in the independent editor', async () => {
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="edit"
        subscription={searchSubscription}
        {...actions}
      />,
    )

    const query = screen.getByLabelText('X 搜索语句')
    expect(query).toHaveValue('(AI OR 大模型) lang:zh')
    expect(screen.getByLabelText('条数上限')).toHaveValue(80)

    fireEvent.change(query, { target: { value: 'agent lang:zh' } })
    fireEvent.click(screen.getByRole('button', { name: '保存订阅' }))

    await waitFor(() => {
      expect(actions.onSave).toHaveBeenCalledWith(8, expect.objectContaining({
        raw_query: 'agent lang:zh',
        max_results: 80,
      }))
    })
  })

  it('selects an information-filtering Adapter and submits it with the subscription', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([])
    mocks.getSettings.mockResolvedValue({
      llm_adapters: [{
        id: 'filter',
        name: '信息筛选专用',
        protocol: 'openai',
        endpoint: 'https://filter.example/v1',
        model: 'filter-model',
        supports_text: true,
        supports_image: false,
        image_response_format: 'base64',
        headers: {},
        api_key_set: true,
        api_key_preview: '…1234',
      }],
    } satisfies Pick<AppSettings, 'llm_adapters'>)
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="edit"
        subscription={subscription}
        {...actions}
      />,
    )

    const selector = await screen.findByLabelText('信息筛选 Adapter')
    expect(selector).toHaveValue('')
    fireEvent.change(selector, { target: { value: 'filter' } })
    fireEvent.click(screen.getByRole('button', { name: '保存订阅' }))

    await waitFor(() => {
      expect(actions.onSave).toHaveBeenCalledWith(7, expect.objectContaining({
        llm_adapter_id: 'filter',
      }))
    })
  })

  it('selects multiple configured article folders and submits their ids with the subscription', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([
      {
        id: 5,
        name: 'AI 工具',
        asset_type: 'article',
        parent_id: null,
        is_system: false,
        ai_ingestion_enabled: true,
        ai_ingestion_keywords: ['AI'],
        ai_ingestion_prompt: '只接受有案例的内容。',
        created_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 6,
        name: 'Agent 实践',
        asset_type: 'article',
        parent_id: null,
        is_system: false,
        ai_ingestion_enabled: true,
        ai_ingestion_keywords: ['Agent'],
        ai_ingestion_prompt: '只接受可执行的方法。',
        created_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 7,
        name: '未配置规则',
        asset_type: 'article',
        parent_id: null,
        is_system: false,
        ai_ingestion_enabled: false,
        ai_ingestion_keywords: [],
        ai_ingestion_prompt: '',
        created_at: '2026-08-01T00:00:00Z',
      },
    ])
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="edit"
        subscription={subscription}
        {...actions}
      />,
    )

    const aiTools = await screen.findByRole('checkbox', { name: /AI 工具/ })
    expect(aiTools).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Agent 实践/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /未配置规则/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('请先在创作资产中配置 AI 入库规则')).toBeVisible()
    expect(screen.queryByRole('button', { name: '保存入库规则' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'AI 筛选入库' })).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: /Agent 实践/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存订阅' }))

    await waitFor(() => {
      expect(actions.onSave).toHaveBeenCalledWith(7, expect.objectContaining({
        ingestion_directory_ids: [5, 6],
      }))
    })
  })

  it('includes selected article folder ids when creating a subscription', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([
      {
        id: 5,
        name: 'AI 工具',
        asset_type: 'article',
        parent_id: null,
        is_system: false,
        ai_ingestion_enabled: true,
        ai_ingestion_keywords: ['AI'],
        ai_ingestion_prompt: '只接受有案例的内容。',
        created_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 6,
        name: 'Agent 实践',
        asset_type: 'article',
        parent_id: null,
        is_system: false,
        ai_ingestion_enabled: true,
        ai_ingestion_keywords: ['Agent'],
        ai_ingestion_prompt: '只接受可执行的方法。',
        created_at: '2026-08-01T00:00:00Z',
      },
    ])
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="create"
        subscription={null}
        {...actions}
      />,
    )

    fireEvent.click(await screen.findByRole('checkbox', { name: /AI 工具/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Agent 实践/ }))
    fireEvent.change(screen.getByLabelText('时间线 URL'), { target: { value: 'https://x.com/anthropic' } })
    fireEvent.click(screen.getByRole('button', { name: '添加时间线订阅' }))

    await waitFor(() => {
      expect(actions.onAdd).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'timeline',
        url: 'https://x.com/anthropic',
        ingestion_directory_ids: [5, 6],
      }))
    })
  })

  it('loads and submits a configured prompt folder alongside article folders', async () => {
    mocks.listCreativeAssetDirectories.mockImplementation(async (assetType: string) => assetType === 'prompt' ? [{
      id: 21,
      name: '图片提示词',
      asset_type: 'prompt',
      parent_id: null,
      is_system: false,
      ai_ingestion_enabled: true,
      ai_ingestion_keywords: ['提示词'],
      ai_ingestion_prompt: '只接受可直接复用的提示词。',
      created_at: '2026-08-01T00:00:00Z',
    }] : [])
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="create"
        subscription={null}
        {...actions}
      />,
    )

    fireEvent.click(await screen.findByRole('checkbox', { name: /图片提示词/ }))
    fireEvent.change(screen.getByLabelText('时间线 URL'), { target: { value: 'https://x.com/prompt-source' } })
    fireEvent.click(screen.getByRole('button', { name: '添加时间线订阅' }))

    await waitFor(() => {
      expect(actions.onAdd).toHaveBeenCalledWith(expect.objectContaining({
        ingestion_directory_ids: [21],
      }))
    })
  })

  it('submits the selected day window for existing-post ingestion', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([])
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="edit"
        subscription={subscription}
        {...actions}
      />,
    )

    const days = screen.getByLabelText('补处理天数')
    expect(days).toHaveValue(7)
    fireEvent.change(days, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '补处理已有帖子' }))

    await waitFor(() => {
      expect(actions.onIngestExisting).toHaveBeenCalledWith(subscription, 3)
    })
  })

  it('rejects an invalid existing-post ingestion day window', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([])
    const actions = callbacks()

    render(
      <XSubscriptionDialog
        open
        mode="edit"
        subscription={subscription}
        {...actions}
      />,
    )

    fireEvent.change(screen.getByLabelText('补处理天数'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '补处理已有帖子' }))

    expect(screen.getByRole('alert')).toHaveTextContent('请输入 1–90 的整数天数')
    expect(actions.onIngestExisting).not.toHaveBeenCalled()
  })
})
