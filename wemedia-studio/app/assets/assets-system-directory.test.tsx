// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


const mocks = vi.hoisted(() => ({
  createCreativeAssetDirectory: vi.fn(),
  deleteCreativeAssetDirectory: vi.fn(),
  listCreativeAssetDirectories: vi.fn(),
  renameCreativeAssetDirectory: vi.fn(),
}))


vi.mock('@/lib/api/assets', () => ({
  createCreativeAssetDirectory: mocks.createCreativeAssetDirectory,
  creativeAssetUrl: (url: string) => url,
  deleteCreativeAssetDirectory: mocks.deleteCreativeAssetDirectory,
  listCreativeAssetDirectories: mocks.listCreativeAssetDirectories,
  renameCreativeAssetDirectory: mocks.renameCreativeAssetDirectory,
}))


import { AssetsClient } from './AssetsClient'


beforeEach(() => {
  mocks.listCreativeAssetDirectories.mockResolvedValue([
    {
      id: 1,
      name: '数字人资产',
      asset_type: 'media',
      parent_id: null,
      is_system: true,
      created_at: '',
    },
    {
      id: 2,
      name: '普通目录',
      asset_type: 'media',
      parent_id: null,
      is_system: false,
      created_at: '',
    },
  ])
})


afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})


describe('digital human system asset directory', () => {
  it('shows a lock and removes mutation controls only for the system folder', async () => {
    render(<AssetsClient initialAssets={[]} />)

    fireEvent.click(screen.getByRole('button', { name: '多媒体' }))

    expect(await screen.findByLabelText('系统目录')).toBeTruthy()
    expect(screen.queryByRole('button', {
      name: '重命名数字人资产',
    })).toBeNull()
    expect(screen.queryByRole('button', {
      name: '删除数字人资产',
    })).toBeNull()
    expect(screen.getByRole('button', {
      name: '重命名普通目录',
    })).toBeTruthy()
    expect(screen.getByRole('button', {
      name: '删除普通目录',
    })).toBeTruthy()
  })
})
