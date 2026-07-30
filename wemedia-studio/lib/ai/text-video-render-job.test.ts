import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { makeTextVideoProject } from '@/lib/text-video/test-fixtures'

import {
  resolveTextVideoAssetUrl,
  runTextVideoRenderJob,
  type TextVideoRenderJobDeps,
} from './text-video-render-job'


const sourceHash = 'a'.repeat(64)

function queuedJob() {
  return {
    id: 301,
    flow: 'text_video_render',
    title: '渲染文字视频',
    status: 'queued',
    input: {
      project_id: 2,
      project_revision: 18,
      render_generation: 3,
      source_hash: sourceHash,
      composition_id: 'tech-text-v1',
      render_input: {
        templateId: 'tech-text-v1',
        templateVersion: 1,
        composition: { width: 1080, height: 1920, fps: 30 },
        audio: '/api/uploads/master.mp3',
        segments: [{
          id: 'scene-1',
          start: 0,
          end: 2.4,
          text: '完成导出',
          highlight: ['导出'],
          animation: 'fade-up',
        }],
        templateProps: {
          theme: 'tech-blue',
          font: 'source-han-sans',
          background: 'dark-grid',
          transition: 'soft-push',
          textDensity: 'standard',
          brandTitle: 'EDIORA',
          brandSubtitle: '述策',
          showBrand: true,
          accentColor: '#69F6FF',
          showProgress: true,
          showSceneNumber: true,
        },
      },
    },
    steps: [],
  }
}

function renderContext() {
  return {
    already_saved: false as const,
    ...queuedJob().input,
  }
}

async function depsForRender() {
  const directory = await mkdtemp(join(tmpdir(), 'wms-render-test-'))
  const readyProject = makeTextVideoProject({
    id: 2,
    output_asset_url: '/api/uploads/result.mp4',
    output_stale: false,
    status: 'completed',
  })
  const progress: number[] = []
  const deps: TextVideoRenderJobDeps = {
    api: {
      getJob: vi.fn().mockResolvedValue(queuedJob()),
      startStep: vi.fn().mockResolvedValue({ id: 901, attempt: 1 }),
      completeStep: vi.fn().mockResolvedValue({}),
      failStep: vi.fn().mockResolvedValue({}),
      completeJob: vi.fn().mockResolvedValue({}),
      getRenderContext: vi.fn().mockResolvedValue(renderContext()),
      updateRenderProgress: vi.fn(async (
        _projectId,
        input,
      ) => {
        progress.push(input.progress)
        return { progress: input.progress }
      }),
      uploadRenderResult: vi.fn(async (
        _projectId,
        outputLocation,
      ) => {
        expect(await readFile(outputLocation)).toEqual(
          Buffer.from(
            '\x00\x00\x00\x18ftypisom\x00\x00\x00\x08mdat',
            'binary',
          ),
        )
        return {
          project: readyProject,
          asset: {
            id: 81,
            url: '/api/uploads/result.mp4',
          },
        }
      }),
      failRender: vi.fn().mockResolvedValue({}),
    },
    bundle: vi.fn().mockResolvedValue('http://bundle.test'),
    selectComposition: vi.fn().mockResolvedValue({
      id: 'tech-text-v1',
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 72,
    }),
    renderMedia: vi.fn(async options => {
      options.onProgress?.({ progress: 0.25 } as never)
      options.onProgress?.({ progress: 1 } as never)
      await writeFile(
        options.outputLocation,
        Buffer.from(
          '\x00\x00\x00\x18ftypisom\x00\x00\x00\x08mdat',
          'binary',
        ),
      )
    }),
    makeTemporaryDirectory: vi.fn().mockResolvedValue(directory),
    apiUrl: () => 'http://api:8000/api',
    browserExecutable: () => '/usr/bin/chromium',
  }
  return { deps, directory, progress, readyProject }
}

it('resolves API upload paths against the API origin exactly once', () => {
  expect(resolveTextVideoAssetUrl(
    '/api/uploads/master.mp3',
    'http://api:8000/api',
  )).toBe('http://api:8000/api/uploads/master.mp3')
  expect(resolveTextVideoAssetUrl(
    'https://cdn.example/master.mp3',
    'http://api:8000/api',
  )).toBe('https://cdn.example/master.mp3')
})

it('renders the frozen composition as h264/aac and removes its temp directory', async () => {
  const { deps, directory, progress, readyProject } = await depsForRender()

  await expect(runTextVideoRenderJob(301, deps)).resolves.toEqual(readyProject)

  expect(deps.selectComposition).toHaveBeenCalledWith({
    serveUrl: 'http://bundle.test',
    id: 'tech-text-v1',
    inputProps: expect.objectContaining({
      audio: 'http://api:8000/api/uploads/master.mp3',
    }),
    browserExecutable: '/usr/bin/chromium',
  })
  expect(deps.renderMedia).toHaveBeenCalledWith(expect.objectContaining({
    codec: 'h264',
    audioCodec: 'aac',
    serveUrl: 'http://bundle.test',
    inputProps: expect.objectContaining({
      audio: 'http://api:8000/api/uploads/master.mp3',
    }),
    browserExecutable: '/usr/bin/chromium',
  }))
  expect(progress).toEqual([25, 100])
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
