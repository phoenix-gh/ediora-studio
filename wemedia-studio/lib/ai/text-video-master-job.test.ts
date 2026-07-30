import { describe, expect, it, vi } from 'vitest'

import { JobFinalizationError } from './digital-human-job'
import { ApiRequestError } from './job-client'
import { runTextVideoMasterJob } from './text-video-master-job'


const FIRST_HASH = 'a'.repeat(64)
const DURABLE_HASH = 'b'.repeat(64)

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 81,
    flow: 'text_video_master_audio',
    title: 'master audio',
    status: 'queued',
    input: {
      project_id: 8,
      source_hash: FIRST_HASH,
    },
    steps: [],
    ...overrides,
  }
}

function assembly(sourceHash = FIRST_HASH) {
  return {
    source_hash: sourceHash,
    asset_id: 31,
    audio_url: '/api/uploads/master.mp3',
    duration: 2.5,
    sample_rate: 44100,
    sample_count: 110250,
    segment_offsets: [
      {
        segment_id: 'a',
        asset_id: 11,
        sample_offset: 0,
        sample_count: 44100,
      },
      {
        segment_id: 'b',
        asset_id: 12,
        sample_offset: 44100,
        sample_count: 66150,
      },
    ],
    owns_asset: true,
  }
}

function aligned(sourceHash = FIRST_HASH) {
  return {
    id: 8,
    master_audio: {
      status: 'ready',
      timeline_status: 'ready',
      source_hash: sourceHash,
      timeline_source: 'forced-alignment',
      word_timings: [
        {
          id: 'word-0-1',
          text: '甲',
          start: 0,
          end: 0.5,
          speech_segment_id: 'a',
        },
      ],
    },
    render_input: {
      audio: '/api/uploads/master.mp3',
    },
  }
}

function readyAssemblyProject(
  sourceHash = FIRST_HASH,
  jobId = 81,
) {
  return {
    id: 8,
    master_audio: {
      ...assembly(sourceHash),
      status: 'ready',
      timeline_status: 'missing',
      job_id: jobId,
    },
    render_input: { audio: '' },
  }
}

function deps(jobValue = job()) {
  const api = {
    getJob: vi.fn().mockResolvedValue(jobValue),
    startStep: vi.fn()
      .mockResolvedValueOnce({ id: 91, attempt: 1 })
      .mockResolvedValueOnce({ id: 92, attempt: 1 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockResolvedValue({}),
    postMasterAssemble: vi.fn().mockResolvedValue(assembly()),
    postMasterAlign: vi.fn().mockImplementation(
      async (
        _projectId: number,
        input: { source_hash: string },
      ) => aligned(input.source_hash),
    ),
    postMasterFailure: vi.fn().mockResolvedValue({
      failure_applied: true,
    }),
  }
  return { api }
}

describe('text video master job', () => {
  it('runs exactly the durable assemble and align steps and sends no offsets to align', async () => {
    const provided = deps()

    await expect(runTextVideoMasterJob(81, provided))
      .resolves.toEqual(aligned())

    expect(provided.api.startStep.mock.calls).toEqual([
      [81, 'assemble_master_audio'],
      [81, 'align_master_timeline'],
    ])
    expect(provided.api.postMasterAssemble).toHaveBeenCalledWith(8, 81)
    expect(provided.api.postMasterAlign).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        step_id: 92,
        attempt: 1,
        claim_token: expect.any(String),
      },
      81,
    )
    expect(provided.api.postMasterAlign.mock.calls[0]?.[1])
      .not.toHaveProperty('offsets')
    expect(provided.api.completeStep.mock.calls).toEqual([
      [81, 91, assembly()],
      [81, 92, aligned()],
    ])
    expect(provided.api.completeJob).toHaveBeenCalledWith(81)
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
  })

  it('recovers the latest succeeded assembly output and never concatenates again', async () => {
    const latestAssembly = {
      ...assembly(),
      asset_id: 32,
      audio_url: '/api/uploads/latest-master.mp3',
    }
    const provided = deps(job({
      status: 'running',
      steps: [
        {
          id: 89,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output: assembly(DURABLE_HASH),
        },
        {
          id: 90,
          key: 'assemble_master_audio',
          attempt: 2,
          status: 'succeeded',
          output: latestAssembly,
        },
      ],
    }))

    await runTextVideoMasterJob(81, provided)

    expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        step_id: 91,
        attempt: 1,
        claim_token: expect.any(String),
      },
      81,
    )
    expect(provided.api.startStep).toHaveBeenCalledOnce()
    expect(provided.api.startStep)
      .toHaveBeenCalledWith(81, 'align_master_timeline')
  })

  it('uses a newer running attempt instead of an older succeeded assembly', async () => {
    const provided = deps(job({
      status: 'running',
      steps: [
        {
          id: 89,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output: assembly(FIRST_HASH),
        },
        {
          id: 93,
          key: 'assemble_master_audio',
          attempt: 2,
          status: 'running',
          output: {},
        },
      ],
    }))

    await runTextVideoMasterJob(81, provided)

    expect(provided.api.postMasterAssemble).toHaveBeenCalledOnce()
    expect(provided.api.completeStep).toHaveBeenCalledWith(
      81,
      93,
      assembly(FIRST_HASH),
    )
    expect(provided.api.postMasterAlign).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        step_id: 91,
        attempt: 1,
        claim_token: expect.any(String),
      },
      81,
    )
  })

  it('uses the durable assembly output after a lost complete-step response', async () => {
    let persisted = false
    const durableAssembly = {
      ...assembly(),
      asset_id: 32,
      audio_url: '/api/uploads/durable-master.mp3',
    }
    const provided = deps()
    provided.api.getJob.mockImplementation(async () => (
      persisted
        ? job({
            status: 'running',
            steps: [{
              id: 91,
              key: 'assemble_master_audio',
              attempt: 1,
              status: 'succeeded',
              output: durableAssembly,
            }],
          })
        : job()
    ))
    provided.api.completeStep.mockImplementation(async (
      _jobId: number,
      stepId: number,
    ) => {
      if (stepId === 91) {
        persisted = true
        throw new TypeError('completeStep response lost')
      }
      return {}
    })

    await runTextVideoMasterJob(81, provided)

    expect(provided.api.postMasterAlign).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        step_id: 92,
        attempt: 1,
        claim_token: expect.any(String),
      },
      81,
    )
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'the durable read fails',
      reconcile: () => Promise.reject(new Error('job read unavailable')),
    },
    {
      name: 'the durable read cannot confirm success',
      reconcile: () => Promise.resolve(job({
        status: 'running',
        steps: [{
          id: 91,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'running',
          output: {},
        }],
      })),
    },
  ])(
    'protects a persisted domain result when $name',
    async ({ reconcile }) => {
      const provided = deps()
      provided.api.getJob
        .mockResolvedValueOnce(job())
        .mockResolvedValueOnce(job())
        .mockResolvedValueOnce(job())
        .mockImplementationOnce(reconcile)
      provided.api.completeStep.mockRejectedValue(
        new TypeError('completeStep response lost'),
      )

      await expect(runTextVideoMasterJob(81, provided))
        .rejects.toBeInstanceOf(JobFinalizationError)

      expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
      expect(provided.api.failStep).not.toHaveBeenCalled()
      expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    },
  )

  it('recovers a latest succeeded alignment and only finalizes the job', async () => {
    const durableAlignment = aligned(FIRST_HASH)
    const provided = deps(job({
      status: 'running',
      steps: [
        {
          id: 91,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output: assembly(FIRST_HASH),
        },
        {
          id: 92,
          key: 'align_master_timeline',
          attempt: 1,
          status: 'succeeded',
          output: durableAlignment,
        },
      ],
    }))

    await expect(runTextVideoMasterJob(81, provided))
      .resolves.toEqual(durableAlignment)

    expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.startStep).not.toHaveBeenCalled()
    expect(provided.api.completeStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).toHaveBeenCalledWith(81)
  })

  it('reports an alignment failure with its explicit API retryability', async () => {
    const provided = deps()
    const failure = new ApiRequestError(
      '逐字对齐置信度不足',
      false,
      true,
    )
    provided.api.postMasterAlign.mockRejectedValue(failure)

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toThrow('逐字对齐置信度不足')

    expect(provided.api.postMasterFailure).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        phase: 'align_master_timeline',
        error: '逐字对齐置信度不足',
        step_id: 92,
        attempt: 1,
        claim_token: expect.any(String),
      },
      81,
    )
    expect(provided.api.failStep).toHaveBeenCalledWith(
      81,
      92,
      failure,
      false,
    )
  })

  it('never reports or fails the shared step while transport outcome is unknown', async () => {
    const provided = deps()
    provided.api.postMasterAlign.mockRejectedValue(
      new TypeError('competing alignment request disconnected'),
    )

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toBeInstanceOf(JobFinalizationError)

    expect(provided.api.postMasterAlign).toHaveBeenCalledTimes(2)
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it('recovers ready domain state after the alignment response is lost', async () => {
    const provided = deps()
    provided.api.postMasterAlign
      .mockRejectedValueOnce(new TypeError('alignment response lost'))
      .mockResolvedValueOnce(aligned())

    await expect(runTextVideoMasterJob(81, provided))
      .resolves.toEqual(aligned())

    expect(provided.api.postMasterAlign).toHaveBeenCalledTimes(2)
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.completeStep).toHaveBeenLastCalledWith(
      81,
      92,
      aligned(),
    )
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).toHaveBeenCalledWith(81)
  })

  it('recovers ready state returned by failure reconciliation', async () => {
    const provided = deps()
    provided.api.postMasterAlign.mockRejectedValue(
      new ApiRequestError('主音频请求发生冲突', false, true),
    )
    provided.api.postMasterFailure.mockResolvedValue({
      ...aligned(),
      failure_applied: false,
    })

    await expect(runTextVideoMasterJob(81, provided))
      .resolves.toEqual(aligned())

    expect(provided.api.completeStep).toHaveBeenLastCalledWith(
      81,
      92,
      aligned(),
    )
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).toHaveBeenCalledWith(81)
  })

  it('uses the latest running alignment attempt and its exact claim identity', async () => {
    const provided = deps(job({
      status: 'running',
      steps: [
        {
          id: 91,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output: assembly(),
        },
        {
          id: 92,
          key: 'align_master_timeline',
          attempt: 1,
          status: 'failed',
          output: {},
        },
        {
          id: 97,
          key: 'align_master_timeline',
          attempt: 2,
          status: 'running',
          output: {},
        },
      ],
    }))

    await runTextVideoMasterJob(81, provided)

    expect(provided.api.startStep).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        step_id: 97,
        attempt: 2,
        claim_token: expect.any(String),
      },
      81,
    )
    expect(provided.api.completeStep).toHaveBeenCalledWith(
      81,
      97,
      aligned(),
    )
  })

  it('reports an assembly failure with its explicit API retryability', async () => {
    const provided = deps()
    const failure = new ApiRequestError('主音频文件过大', false)
    provided.api.postMasterAssemble.mockRejectedValue(failure)

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toThrow('主音频文件过大')

    expect(provided.api.postMasterFailure).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        phase: 'assemble_master_audio',
        error: '主音频文件过大',
      },
      81,
    )
    expect(provided.api.failStep).toHaveBeenCalledWith(
      81,
      91,
      failure,
      false,
    )
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
  })

  it('recovers a committed assembly from the failure probe without concatenating again', async () => {
    const provided = deps()
    provided.api.postMasterAssemble.mockRejectedValue(
      new TypeError('assembly response lost after commit'),
    )
    provided.api.postMasterFailure.mockResolvedValue({
      ...readyAssemblyProject(),
      failure_applied: false,
    })

    await expect(runTextVideoMasterJob(81, provided))
      .resolves.toEqual(aligned())

    expect(provided.api.postMasterAssemble).toHaveBeenCalledOnce()
    expect(provided.api.postMasterFailure).toHaveBeenCalledOnce()
    expect(provided.api.completeStep).toHaveBeenNthCalledWith(
      1,
      81,
      91,
      assembly(),
    )
    expect(provided.api.postMasterAlign).toHaveBeenCalledOnce()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'another source snapshot',
      project: readyAssemblyProject(DURABLE_HASH),
    },
    {
      name: 'another job owner',
      project: readyAssemblyProject(FIRST_HASH, 82),
    },
  ])(
    'fails closed when an assembly failure probe reports ready state for $name',
    async ({ project }) => {
      const provided = deps()
      provided.api.postMasterAssemble.mockRejectedValue(
        new TypeError('assembly response lost after commit'),
      )
      provided.api.postMasterFailure.mockResolvedValue({
        ...project,
        failure_applied: false,
      })

      await expect(runTextVideoMasterJob(81, provided))
        .rejects.toBeInstanceOf(JobFinalizationError)

      expect(provided.api.postMasterAssemble).toHaveBeenCalledOnce()
      expect(provided.api.completeStep).not.toHaveBeenCalled()
      expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
      expect(provided.api.failStep).not.toHaveBeenCalled()
    },
  )

  it('recovers a lost complete-job response when durable state is succeeded', async () => {
    const provided = deps()
    let finalizing = false
    provided.api.getJob.mockImplementation(async () => (
      finalizing ? job({ status: 'succeeded' }) : job()
    ))
    provided.api.completeJob.mockImplementation(async () => {
      finalizing = true
      throw new TypeError('completeJob response lost')
    })

    await expect(runTextVideoMasterJob(81, provided))
      .resolves.toEqual(aligned())

    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'the final durable read fails',
      reconcile: () => Promise.reject(new Error('job read unavailable')),
    },
    {
      name: 'the final durable read is not succeeded',
      reconcile: () => Promise.resolve(job({ status: 'running' })),
    },
  ])(
    'does not turn job-finalization uncertainty into failure when $name',
    async ({ reconcile }) => {
      const provided = deps()
      let finalizing = false
      provided.api.getJob.mockImplementation(async () => (
        finalizing ? reconcile() : job()
      ))
      provided.api.completeJob.mockImplementation(async () => {
        finalizing = true
        throw new TypeError('completeJob response lost')
      })

      await expect(runTextVideoMasterJob(81, provided))
        .rejects.toBeInstanceOf(JobFinalizationError)

      expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
      expect(provided.api.failStep).not.toHaveBeenCalled()
    },
  )

  it('fails closed on an invalid succeeded durable output', async () => {
    const provided = deps(job({
      status: 'running',
      steps: [{
        id: 91,
        key: 'assemble_master_audio',
        attempt: 1,
        status: 'succeeded',
        output: {
          ...assembly(),
          sample_count: 0,
        },
      }],
    }))

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toBeInstanceOf(JobFinalizationError)

    expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })

  it('fails closed when durable assembly output is from another source snapshot', async () => {
    const provided = deps(job({
      status: 'running',
      steps: [{
        id: 91,
        key: 'assemble_master_audio',
        attempt: 1,
        status: 'succeeded',
        output: assembly(DURABLE_HASH),
      }],
    }))

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toBeInstanceOf(JobFinalizationError)

    expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it('rejects a live assembly response from another source snapshot', async () => {
    const provided = deps()
    provided.api.postMasterAssemble.mockResolvedValue(
      assembly(DURABLE_HASH),
    )

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toThrow('已完成的主音频拼接结果无效')

    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.postMasterFailure).toHaveBeenCalledWith(
      8,
      {
        source_hash: FIRST_HASH,
        phase: 'assemble_master_audio',
        error: '已完成的主音频拼接结果无效',
      },
      81,
    )
    expect(provided.api.failStep).toHaveBeenCalledWith(
      81,
      91,
      expect.any(Error),
      false,
    )
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'a string positive integer',
      output: {
        ...assembly(),
        asset_id: '31',
      },
    },
    {
      name: 'a boolean nonnegative integer',
      output: {
        ...assembly(),
        segment_offsets: [
          {
            ...assembly().segment_offsets[0],
            sample_offset: false,
          },
          assembly().segment_offsets[1],
        ],
      },
    },
    {
      name: 'a string duration',
      output: {
        ...assembly(),
        duration: '2.5',
      },
    },
  ])(
    'fails closed when durable assembly output contains $name',
    async ({ output }) => {
      const provided = deps(job({
        status: 'running',
        steps: [{
          id: 91,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output,
        }],
      }))

      await expect(runTextVideoMasterJob(81, provided))
        .rejects.toBeInstanceOf(JobFinalizationError)

      expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
      expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
      expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
      expect(provided.api.failStep).not.toHaveBeenCalled()
      expect(provided.api.completeJob).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'a boolean positive integer',
      output: {
        ...assembly(),
        asset_id: true,
      },
    },
    {
      name: 'a string nonnegative integer',
      output: {
        ...assembly(),
        segment_offsets: [
          {
            ...assembly().segment_offsets[0],
            sample_offset: '0',
          },
          assembly().segment_offsets[1],
        ],
      },
    },
    {
      name: 'a boolean duration',
      output: {
        ...assembly(),
        duration: true,
        sample_count: 44100,
        segment_offsets: [assembly().segment_offsets[0]],
      },
    },
  ])(
    'rejects live assembly output containing $name as non-retryable',
    async ({ output }) => {
      const provided = deps()
      provided.api.postMasterAssemble.mockResolvedValue(output as never)

      await expect(runTextVideoMasterJob(81, provided))
        .rejects.toThrow('已完成的主音频拼接结果无效')

      expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
      expect(provided.api.postMasterFailure).toHaveBeenCalledOnce()
      expect(provided.api.failStep).toHaveBeenCalledWith(
        81,
        91,
        expect.any(Error),
        false,
      )
      expect(provided.api.completeJob).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'duplicate segment ids',
      output: {
        ...assembly(),
        segment_offsets: [
          assembly().segment_offsets[0],
          {
            ...assembly().segment_offsets[1],
            segment_id: 'a',
          },
        ],
      },
    },
    {
      name: 'non-contiguous sample offsets',
      output: {
        ...assembly(),
        segment_offsets: [
          assembly().segment_offsets[0],
          {
            ...assembly().segment_offsets[1],
            sample_offset: 44101,
          },
        ],
      },
    },
    {
      name: 'a segment total different from the master sample count',
      output: {
        ...assembly(),
        sample_count: 110251,
      },
    },
    {
      name: 'a duration different from the sample-derived duration',
      output: {
        ...assembly(),
        duration: 2.4,
      },
    },
  ])(
    'fails closed on durable assembly output with $name',
    async ({ output }) => {
      const provided = deps(job({
        status: 'running',
        steps: [{
          id: 91,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output,
        }],
      }))

      await expect(runTextVideoMasterJob(81, provided))
        .rejects.toBeInstanceOf(JobFinalizationError)

      expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
      expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
      expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
      expect(provided.api.failStep).not.toHaveBeenCalled()
      expect(provided.api.completeJob).not.toHaveBeenCalled()
    },
  )

  it('fails closed on a durable ready alignment with no word timings', async () => {
    const emptyAlignment = aligned()
    emptyAlignment.master_audio.word_timings = []
    const provided = deps(job({
      status: 'running',
      steps: [
        {
          id: 91,
          key: 'assemble_master_audio',
          attempt: 1,
          status: 'succeeded',
          output: assembly(),
        },
        {
          id: 92,
          key: 'align_master_timeline',
          attempt: 1,
          status: 'succeeded',
          output: emptyAlignment,
        },
      ],
    }))

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toBeInstanceOf(JobFinalizationError)

    expect(provided.api.postMasterAssemble).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it('does not record a work failure after the job is concurrently cancelled', async () => {
    let cancelled = false
    const provided = deps()
    provided.api.getJob.mockImplementation(async () => job({
      status: cancelled ? 'cancelled' : 'running',
    }))
    provided.api.postMasterAssemble.mockImplementation(async () => {
      cancelled = true
      throw new ApiRequestError('任务状态已更新', false)
    })

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toMatchObject({ name: 'MasterJobCancelledError' })

    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.completeStep).not.toHaveBeenCalled()
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it('does not complete a step after its work concurrently cancels the job', async () => {
    let cancelled = false
    const provided = deps()
    provided.api.getJob.mockImplementation(async () => job({
      status: cancelled ? 'cancelled' : 'running',
    }))
    provided.api.postMasterAssemble.mockImplementation(async () => {
      cancelled = true
      return assembly()
    })

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toMatchObject({ name: 'MasterJobCancelledError' })

    expect(provided.api.completeStep).not.toHaveBeenCalled()
    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it('classifies a cancellation during step completion without reconciliation retries', async () => {
    let cancelled = false
    const provided = deps()
    provided.api.getJob.mockImplementation(async () => job({
      status: cancelled ? 'cancelled' : 'running',
      steps: cancelled
        ? [{
            id: 91,
            key: 'assemble_master_audio',
            attempt: 1,
            status: 'running',
            output: {},
          }]
        : [],
    }))
    provided.api.completeStep.mockImplementation(async () => {
      cancelled = true
      throw new ApiRequestError('任务已取消', false)
    })

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toMatchObject({ name: 'MasterJobCancelledError' })

    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
    expect(provided.api.postMasterAlign).not.toHaveBeenCalled()
    expect(provided.api.completeJob).not.toHaveBeenCalled()
  })

  it('classifies cancellation during job finalization without retrying forever', async () => {
    let cancelled = false
    const provided = deps()
    provided.api.getJob.mockImplementation(async () => job({
      status: cancelled ? 'cancelled' : 'running',
    }))
    provided.api.completeJob.mockImplementation(async () => {
      cancelled = true
      throw new ApiRequestError('任务已取消', false)
    })

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toMatchObject({ name: 'MasterJobCancelledError' })

    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })

  it('does not turn a plain complete-job failure into domain or step failure', async () => {
    const provided = deps()
    provided.api.completeJob.mockRejectedValue(
      new TypeError('completeJob response lost'),
    )

    await expect(runTextVideoMasterJob(81, provided))
      .rejects.toBeInstanceOf(JobFinalizationError)

    expect(provided.api.postMasterFailure).not.toHaveBeenCalled()
    expect(provided.api.failStep).not.toHaveBeenCalled()
  })
})
