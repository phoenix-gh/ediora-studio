// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachPromptGeneration: vi.fn(),
  createPromptGeneration: vi.fn(),
  deletePromptGeneration: vi.fn(),
  listPromptGenerations: vi.fn(),
  uploadCreativeAsset: vi.fn(),
}))

vi.mock('@/lib/api/assets', () => ({
  attachPromptGeneration: mocks.attachPromptGeneration,
  createPromptGeneration: mocks.createPromptGeneration,
  creativeAssetUrl: (url: string) => new URL(url, 'http://media.test').toString(),
  deletePromptGeneration: mocks.deletePromptGeneration,
  listPromptGenerations: mocks.listPromptGenerations,
  uploadCreativeAsset: mocks.uploadCreativeAsset,
}))

import type { CreativeAsset, CreativeAssetDirectory, PromptGeneration } from '@/lib/api/assets'
import { PromptAssetWorkspace } from './PromptAssetWorkspace'

const prompt = (kind: 'image' | 'video' | 'other' = 'image'): CreativeAsset => ({
  id: 10,
  asset_type: 'prompt',
  prompt_kind: kind,
  media_kind: '',
  title: '城市提示词',
  content: '一张未来城市海报',
  url: '',
  media_type: '',
  filename: '',
  directory: '',
  tags: [],
  source: 'manual',
  created_at: '2026-08-09T10:00:00Z',
  updated_at: '2026-08-09T10:00:00Z',
})

const media: CreativeAsset = {
  ...prompt('image'),
  id: 88,
  asset_type: 'media',
  prompt_kind: '',
  media_kind: 'image',
  title: '生成图片',
  url: '/api/uploads/generated.png',
}

const generation = (overrides: Partial<PromptGeneration> = {}): PromptGeneration => ({
  id: 17,
  prompt_asset_id: 10,
  media_asset_id: null,
  provider: 'openai-compatible',
  model: 'gpt-image-1',
  status: 'queued',
  job_id: 72,
  error: '',
  generated_at: null,
  created_at: '2026-08-09T10:00:00Z',
  media: null,
  ...overrides,
})

const directory: CreativeAssetDirectory = {
  id: 1,
  name: '海报',
  asset_type: 'prompt',
  parent_id: null,
  is_system: false,
  ai_ingestion_enabled: false,
  ai_ingestion_keywords: [],
  ai_ingestion_prompt: '',
  created_at: '2026-08-09T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listPromptGenerations.mockResolvedValue([])
  mocks.createPromptGeneration.mockResolvedValue(generation())
  mocks.uploadCreativeAsset.mockResolvedValue(media)
  mocks.attachPromptGeneration.mockResolvedValue(generation({ status: 'succeeded', media_asset_id: 88, generated_at: '2026-08-09T10:01:00Z', media }))
  mocks.deletePromptGeneration.mockResolvedValue(undefined)
})

describe('PromptAssetWorkspace', () => {
  it('renders prompt editing fields and recent generation history', async () => {
    mocks.listPromptGenerations.mockResolvedValue([
      generation({ status: 'succeeded', media_asset_id: media.id, generated_at: '2026-08-09T10:01:00Z', media }),
    ])
    render(
      <PromptAssetWorkspace
        assets={[prompt()]}
        directories={[directory]}
        selected={prompt()}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByRole('region', { name: '提示词列表' })).toBeVisible()
    expect(screen.getByRole('region', { name: '提示词编辑器' })).toBeVisible()
    expect(screen.getByLabelText('提示词正文')).toHaveValue('一张未来城市海报')
    expect(await screen.findByRole('img', { name: '生成图片' })).toHaveAttribute(
      'src',
      'http://media.test/api/uploads/generated.png',
    )
    expect(screen.getByText('模型：gpt-image-1')).toBeVisible()
  })

  it('starts image generation and does not expose it for video prompts', async () => {
    const user = userEvent.setup()
    render(
      <PromptAssetWorkspace
        assets={[prompt()]}
        directories={[]}
        selected={prompt()}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '生成图片' }))
    expect(mocks.createPromptGeneration).toHaveBeenCalledWith(10)
    expect(await screen.findAllByText('排队中')).not.toHaveLength(0)
  })

  it('does not expose direct generation for video prompts', () => {
    render(
      <PromptAssetWorkspace
        assets={[prompt('video')]}
        directories={[]}
        selected={prompt('video')}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '生成图片' })).toBeNull()
    expect(screen.getByRole('button', { name: '补录视频' })).toBeVisible()
  })

  it('uploads a manual result before attaching it to the prompt history', async () => {
    const user = userEvent.setup()
    render(
      <PromptAssetWorkspace
        assets={[prompt()]}
        directories={[]}
        selected={prompt()}
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onSave={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    const file = new File(['png'], 'manual.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('提示词编辑器').querySelector('input[type="file"]')!, file)

    await waitFor(() => expect(mocks.uploadCreativeAsset).toHaveBeenCalledWith('image', file))
    expect(mocks.attachPromptGeneration).toHaveBeenCalledWith(10, 88)
  })
})
