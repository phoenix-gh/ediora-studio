import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTextVideoProject,
  deleteTextVideoProject,
  listTextVideoProjects,
  updateTextVideoProject,
} from './text-videos'

const project = {
  id: 7,
  title: '测试作品',
  status: 'draft',
  stage: 'script',
  script: '',
  voice_settings: {},
  paragraphs: [],
  render_input: {},
  cover_asset_url: '',
  output_asset_url: '',
  revision: 1,
  duration: 0,
  aspect_ratio: '9:16',
  created_at: '2026-07-29T00:00:00Z',
  updated_at: '2026-07-29T00:00:00Z',
}

describe('text-video project API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists, creates, updates, and deletes projects', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([project]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(project), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...project, revision: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await listTextVideoProjects()
    await createTextVideoProject('新的作品')
    await updateTextVideoProject(7, { revision: 1, title: '新标题' })
    await deleteTextVideoProject(7)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000/api/text-videos',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000/api/text-videos',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: '新的作品' }) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8000/api/text-videos/7',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ revision: 1, title: '新标题' }) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8000/api/text-videos/7',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
