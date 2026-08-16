import { describe, expect, it, vi } from 'vitest'

import {
  buildAcrossfadeFilter,
  runDigitalHumanStitchJob,
  type StitchJobDeps,
} from './digital-human-stitch-job'


describe('digital-human stitch job', () => {
  it('hard-cuts video and audio on one timeline', () => {
    const filter = buildAcrossfadeFilter(3)
    expect(filter.video).toContain('concat=n=3:v=1:a=1[v][a]')
    expect(filter.video).not.toContain('acrossfade')
  })

  it('concatenates clips and marks the render succeeded', async () => {
    const api = {
      getJob: vi.fn().mockResolvedValue({
        id: 1,
        flow: 'digital_human_stitch',
        status: 'queued',
        input: { render_id: 4 },
        steps: [],
      }),
      startStep: vi.fn().mockResolvedValue({ id: 1 }),
      completeStep: vi.fn(),
      failStep: vi.fn(),
      completeJob: vi.fn(),
      getRenderContext: vi.fn().mockResolvedValue({
        id: 4,
        project_id: 9,
        version: 1,
        status: 'queued',
        clips: [
          { url: '/api/uploads/a.mp4', filename: 'a.mp4', media_type: 'video/mp4' },
          { url: '/api/uploads/b.mp4', filename: 'b.mp4', media_type: 'video/mp4' },
        ],
      }),
      updateRender: vi.fn(),
      fetchLocalAsset: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1]) }),
      saveVideoAsset: vi.fn().mockResolvedValue({ id: 88, url: '/api/uploads/out.mp4' }),
    }
    const concat = vi.fn().mockImplementation(async (_files: string[], output: string) => {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(output, Buffer.from([7, 7, 7]))
    })
    const deps = { api, concat } as unknown as StitchJobDeps

    await runDigitalHumanStitchJob(21, deps)

    expect(concat).toHaveBeenCalled()
    expect(api.saveVideoAsset).toHaveBeenCalled()
    expect(api.updateRender).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ status: 'succeeded', video_asset_id: 88 }),
      21,
    )
    expect(api.completeJob).toHaveBeenCalledWith(21)
  })

  it('marks the render failed when a clip cannot be read', async () => {
    const api = {
      getJob: vi.fn().mockResolvedValue({
        id: 1,
        flow: 'digital_human_stitch',
        status: 'queued',
        input: { render_id: 4 },
        steps: [],
      }),
      startStep: vi.fn().mockResolvedValue({ id: 1 }),
      completeStep: vi.fn(),
      failStep: vi.fn(),
      completeJob: vi.fn(),
      getRenderContext: vi.fn().mockResolvedValue({
        id: 4,
        project_id: 9,
        version: 1,
        status: 'queued',
        clips: [
          { url: '/api/uploads/a.mp4', filename: 'a.mp4', media_type: 'video/mp4' },
        ],
      }),
      updateRender: vi.fn(),
      fetchLocalAsset: vi.fn().mockRejectedValue(new Error('无法读取镜头成片 (404)')),
      saveVideoAsset: vi.fn(),
    }
    const deps = {
      api,
      concat: vi.fn(),
    } as unknown as StitchJobDeps

    await expect(runDigitalHumanStitchJob(21, deps)).rejects.toThrow('无法读取镜头成片 (404)')
    expect(api.updateRender).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        status: 'failed',
        error: '无法读取镜头成片 (404)',
      }),
      21,
    )
    expect(api.completeJob).not.toHaveBeenCalled()
  })
})
