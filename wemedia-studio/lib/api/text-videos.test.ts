import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTextVideoProject,
  deleteTextVideoProject,
  listTextVideoProjects,
  updateTextVideoProject,
} from './text-videos'
import { makeTextVideoProject } from '@/lib/text-video/test-fixtures'

const project = makeTextVideoProject({ id: 7, title: '测试作品' })

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

  it('provides complete authoritative document fixtures', () => {
    expect(project.paragraphs[0]).toEqual(expect.objectContaining({
      status: 'draft',
      generation_revision: 0,
      source_hash: '',
      job_id: null,
    }))
    expect(project.master_audio).toEqual(expect.objectContaining({
      status: 'missing',
      timeline_status: 'missing',
      word_timings: [],
    }))
    expect(project.scene_plan).toEqual(expect.objectContaining({
      status: 'missing',
      generation_revision: 0,
      scenes: [],
      applied_job_id: null,
    }))
  })
})
