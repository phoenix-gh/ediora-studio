// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TextVideoProjectsClient } from './TextVideoProjectsClient'

const push = vi.fn()
const createProject = vi.fn()
const deleteProject = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@/lib/api/text-videos', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/text-videos')>()
  return {
    ...original,
    createTextVideoProject: (...args: unknown[]) => createProject(...args),
    deleteTextVideoProject: (...args: unknown[]) => deleteProject(...args),
  }
})

const project = {
  id: 7,
  title: 'AI 视频创作',
  status: 'draft' as const,
  stage: 'script' as const,
  cover_asset_url: '',
  output_asset_url: '',
  output_stale: false,
  revision: 1,
  duration: 25.3,
  aspect_ratio: '9:16',
  created_at: '2026-07-29T00:00:00Z',
  updated_at: '2026-07-29T00:00:00Z',
}

describe('TextVideoProjectsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createProject.mockResolvedValue(project)
    deleteProject.mockResolvedValue(undefined)
  })

  it('renders project management and opens a persisted project', () => {
    render(<TextVideoProjectsClient initialProjects={[project]} />)

    expect(screen.getByRole('heading', { name: '文字视频' })).toBeVisible()
    expect(screen.getAllByText('AI 视频创作')[0]).toBeVisible()
    expect(screen.getByRole('link', { name: '继续编辑 AI 视频创作' })).toHaveAttribute('href', '/text-video/7')
  })

  it('creates a database project before navigating to the editor', async () => {
    const user = userEvent.setup()
    render(<TextVideoProjectsClient initialProjects={[]} />)

    await user.click(screen.getAllByRole('button', { name: '新建文字视频' })[0])

    expect(createProject).toHaveBeenCalledWith('未命名文字视频')
    expect(push).toHaveBeenCalledWith('/text-video/7')
  })

  it('uses a project alert dialog before deletion', async () => {
    const user = userEvent.setup()
    render(<TextVideoProjectsClient initialProjects={[project]} />)

    await user.click(screen.getByRole('button', { name: '删除 AI 视频创作' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toBeVisible()
    expect(within(dialog).getByText(/AI 视频创作/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: '确认删除' }))
    expect(deleteProject).toHaveBeenCalledWith(7)
    expect(screen.queryAllByText('AI 视频创作')).toHaveLength(0)
  })
})
