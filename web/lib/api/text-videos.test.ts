import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTextVideoProject,
  deleteTextVideoProject,
  generateTextVideoScenePlan,
  listTextVideoProjects,
  renderTextVideoProject,
  textVideoOutputDownloadUrl,
  updateTextVideoProject,
  type TextVideoProjectSummary,
} from './text-videos'
import { makeTextVideoProject } from '@/lib/text-video/test-fixtures'

const project = makeTextVideoProject({ id: 7, title: '测试作品' })

function outputStaleValue(summary: TextVideoProjectSummary): boolean {
  return summary.output_stale
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

  it('provides complete authoritative document fixtures', () => {
    expect(outputStaleValue(project)).toBe(false)
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

  it('launches AI scene generation with the exact public route contract', async () => {
    const response = {
      jobs: [{
        id: 41,
        flow: 'text_video_scene_plan',
        target_id: 7,
      }],
      project: { id: 7 },
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(response),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const input = {
      revision: 12,
      scope: 'selected' as const,
      selected_scene_id: 'scene-2',
      direction: '更有冲击力',
    }

    await expect(generateTextVideoScenePlan(7, input))
      .resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/text-videos\/7\/scene-plan\/generate$/u),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
      }),
    )
  })

  it('launches the final render and exposes its attachment URL', async () => {
    const response = {
      jobs: [{
        id: 301,
        flow: 'text_video_render',
        target_id: 7,
      }],
      project,
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(response),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(renderTextVideoProject(7, 12)).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/text-videos/7/render',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ revision: 12 }),
      }),
    )
    expect(textVideoOutputDownloadUrl(7)).toBe(
      'http://localhost:8000/api/text-videos/7/output/download',
    )
  })
})
