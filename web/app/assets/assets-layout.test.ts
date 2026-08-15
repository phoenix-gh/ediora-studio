// @vitest-environment jsdom

import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listCreativeAssetDirectories: vi.fn(),
}))

vi.mock('@/lib/api/assets', () => ({
  creativeAssetUrl: (url: string) => url,
  listCreativeAssetDirectories: mocks.listCreativeAssetDirectories,
}))

import { AssetsClient } from './AssetsClient'

describe('creative asset media layout', () => {
  beforeEach(() => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([])
  })

  it('opens previews in the large application dialog on double click', async () => {
    const user = userEvent.setup()
    render(createElement(AssetsClient, { initialAssets: [{
      id: 1,
      asset_type: 'media',
      media_kind: 'audio',
      title: '采访录音',
      content: '',
      url: '/api/uploads/interview.mp3',
      media_type: 'audio/mpeg',
      filename: 'interview.mp3',
      directory: '',
      tags: [],
      source: '',
      created_at: '',
      updated_at: '',
    }] }))

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    const card = screen.getByRole('button', { name: /采访录音/ })
    await user.dblClick(card)

    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'lg')
  })
})
