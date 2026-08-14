// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreativeAsset } from '@/lib/api/assets'

const assets = vi.hoisted(() => ({
  portrait: {
    id: 1,
    asset_type: 'media',
    media_kind: 'image',
    title: '正面形象照',
    url: '/api/uploads/portrait.png',
    media_type: 'image/png',
    filename: 'portrait.png',
    content: '',
    directory: '',
    tags: [],
    source: 'upload',
    created_at: '',
    updated_at: '',
  },
  voice: {
    id: 2,
    asset_type: 'media',
    media_kind: 'audio',
    title: '声音样本',
    url: '/api/uploads/voice.wav',
    media_type: 'audio/wav',
    filename: 'voice.wav',
    content: '',
    directory: '',
    tags: [],
    source: 'upload',
    created_at: '',
    updated_at: '',
  },
  environment: {
    id: 3,
    asset_type: 'media',
    media_kind: 'image',
    title: '明亮演播室',
    url: '/api/uploads/studio.jpg',
    media_type: 'image/jpeg',
    filename: 'studio.jpg',
    content: '',
    directory: '',
    tags: [],
    source: 'upload',
    created_at: '',
    updated_at: '',
  },
}))

const mocks = vi.hoisted(() => ({
  createDigitalHuman: vi.fn(),
  updateDigitalHuman: vi.fn(),
  listCreativeAssets: vi.fn(),
  uploadCreativeAsset: vi.fn(),
  createJob: vi.fn(),
  getJob: vi.fn(),
}))

vi.mock('@/lib/api/digital-humans', () => ({
  createDigitalHuman: mocks.createDigitalHuman,
  updateDigitalHuman: mocks.updateDigitalHuman,
}))
vi.mock('@/lib/api/assets', () => ({
  listCreativeAssets: mocks.listCreativeAssets,
  uploadCreativeAsset: mocks.uploadCreativeAsset,
  creativeAssetUrl: (url: string) => url,
}))
vi.mock('@/lib/api/jobs', () => ({
  createJob: mocks.createJob,
  getJob: mocks.getJob,
}))

import { EnvironmentPickerDialog } from './EnvironmentPickerDialog'
import { RoleEditorDialog } from './RoleEditorDialog'


afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})


describe('digital-human role creation', () => {
  it('creates a role from portrait voice and default environment assets', async () => {
    mocks.listCreativeAssets.mockResolvedValue([
      assets.portrait,
      assets.voice,
      assets.environment,
    ])
    mocks.createDigitalHuman.mockResolvedValue({ id: 8, name: '林晓' })

    render(
      <RoleEditorDialog
        open
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText('角色名称'), {
      target: { value: '林晓' },
    })
    fireEvent.click(screen.getByRole('button', { name: '选择人物形象' }))
    fireEvent.click(await screen.findByRole('button', { name: '正面形象照' }))
    fireEvent.click(screen.getByRole('button', { name: '选择声音样本' }))
    fireEvent.click(await screen.findByRole('button', { name: '声音样本' }))
    fireEvent.click(screen.getByRole('button', { name: '选择默认环境' }))
    fireEvent.click(await screen.findByRole('button', { name: '明亮演播室' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并开始处理' }))

    await waitFor(() => {
      expect(mocks.createDigitalHuman).toHaveBeenCalledWith({
        name: '林晓',
        portrait_asset_id: assets.portrait.id,
        voice_sample_asset_id: assets.voice.id,
        default_environment_asset_id: assets.environment.id,
      })
    })
  })

  it('offers upload asset and AI generation for environment images', async () => {
    mocks.listCreativeAssets.mockResolvedValue([assets.environment])

    render(
      <EnvironmentPickerDialog
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByRole('tab', { name: '上传图片' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '创作资产' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'AI 生成' })).toBeTruthy()
  })

  it('edits an existing role and keeps its current assets selected', async () => {
    mocks.updateDigitalHuman.mockResolvedValue({
      id: 8,
      name: '林晓（新版）',
    })

    render(
      <RoleEditorDialog
        open
        role={{
          id: 8,
          name: '林晓',
          status: 'ready',
          provider: 'heygen',
          portrait_asset_id: assets.portrait.id,
          voice_sample_asset_id: assets.voice.id,
          default_environment_asset_id: assets.environment.id,
          look_asset_id: null,
          portrait: assets.portrait as CreativeAsset,
          voice_sample: assets.voice as CreativeAsset,
          default_environment: assets.environment as CreativeAsset,
          look: null,
          heygen_avatar_group_id: 'group-1',
          heygen_avatar_id: 'avatar-1',
          heygen_voice_id: 'voice-1',
          provider_state: {},
          setup_job_id: 10,
          error: '',
          archived_at: null,
          created_at: '',
          updated_at: '',
        }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    )

    expect(screen.getByText('编辑数字人角色')).toBeTruthy()
    expect(screen.getByRole('button', { name: '正面形象照' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '声音样本' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '明亮演播室' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('角色名称'), {
      target: { value: '林晓（新版）' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }))

    await waitFor(() => {
      expect(mocks.updateDigitalHuman).toHaveBeenCalledWith(8, {
        name: '林晓（新版）',
        portrait_asset_id: assets.portrait.id,
        voice_sample_asset_id: assets.voice.id,
        default_environment_asset_id: assets.environment.id,
      })
    })
  })
})
