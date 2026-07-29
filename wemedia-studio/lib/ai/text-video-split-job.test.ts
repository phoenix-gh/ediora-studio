import { expect, it, vi } from 'vitest'

import { runTextVideoSplitJob } from './text-video-split-job'


it('validates AI boundary IDs server-side before completing the durable proposal step', async () => {
  const api = {
    getJob: vi.fn()
      .mockResolvedValueOnce({
        id: 31,
        flow: 'text_video_split_preview',
        status: 'queued',
        input: {
          project_id: 7,
          script: '甲。乙。',
          script_hash: 'a'.repeat(64),
          direction: '适合短句口播',
          candidates: [
            { id: 'boundary-a', kind: 'sentence', context: '甲。乙。' },
          ],
        },
        steps: [],
      })
      .mockResolvedValueOnce({ id: 31, status: 'running', steps: [] }),
    startStep: vi.fn().mockResolvedValue({ id: 41 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockResolvedValue({}),
    validateProposal: vi.fn().mockResolvedValue({
      segments: [
        { id: 'segment-a', text: '甲。', estimated_duration: 0.5, reason: 'AI 建议分段' },
        { id: 'segment-b', text: '乙。', estimated_duration: 0.5, reason: 'AI 建议分段' },
      ],
      speech_split_mode: 'auto' as const,
    }),
  }
  const generateBoundaries = vi.fn().mockResolvedValue({
    boundaries: [{ id: 'boundary-a', reason: '完整句' }],
  })

  const proposal = await runTextVideoSplitJob(31, { api, generateBoundaries })

  expect(generateBoundaries).toHaveBeenCalledWith(expect.objectContaining({
    script: '甲。乙。',
    direction: '适合短句口播',
    candidates: [{ id: 'boundary-a', kind: 'sentence', context: '甲。乙。' }],
  }))
  expect(api.validateProposal).toHaveBeenCalledWith(7, 31, {
    boundary_ids: ['boundary-a'],
    script_hash: 'a'.repeat(64),
  })
  expect(proposal.segments).toEqual([
    { id: 'segment-a', text: '甲。', estimated_duration: 0.5, reason: '完整句' },
    { id: 'segment-b', text: '乙。', estimated_duration: 0.5, reason: '完整口播段' },
  ])
  expect(api.completeStep).toHaveBeenCalledWith(31, 41, proposal)
  expect(api.completeJob).toHaveBeenCalledWith(31)
})

it('recovers a succeeded proposal step by completing the job without rerunning AI or validation', async () => {
  const proposal = {
    segments: [
      { id: 'segment-a', text: '甲。乙。', estimated_duration: 1, reason: '完整口播段' },
    ],
    speech_split_mode: 'auto' as const,
  }
  const api = {
    getJob: vi.fn().mockResolvedValue({
      id: 31,
      flow: 'text_video_split_preview',
      status: 'running',
      input: {},
      steps: [{
        id: 41,
        key: 'propose_boundaries',
        attempt: 1,
        status: 'succeeded',
        output: proposal,
      }],
    }),
    startStep: vi.fn(),
    completeStep: vi.fn(),
    failStep: vi.fn(),
    completeJob: vi.fn().mockResolvedValue({}),
    validateProposal: vi.fn(),
  }
  const generateBoundaries = vi.fn()

  await expect(runTextVideoSplitJob(31, { api, generateBoundaries }))
    .resolves.toEqual(proposal)

  expect(api.completeJob).toHaveBeenCalledWith(31)
  expect(generateBoundaries).not.toHaveBeenCalled()
  expect(api.validateProposal).not.toHaveBeenCalled()
  expect(api.startStep).not.toHaveBeenCalled()
  expect(api.completeStep).not.toHaveBeenCalled()
  expect(api.failStep).not.toHaveBeenCalled()
})

it('returns a cancelled job proposal without finalization, AI, validation, or step failure', async () => {
  const proposal = {
    segments: [
      { id: 'segment-a', text: '甲。乙。', estimated_duration: 1, reason: '完整口播段' },
    ],
    speech_split_mode: 'auto' as const,
  }
  const api = {
    getJob: vi.fn().mockResolvedValue({
      id: 31,
      flow: 'text_video_split_preview',
      status: 'cancelled',
      input: {},
      steps: [{
        id: 41,
        key: 'propose_boundaries',
        attempt: 1,
        status: 'succeeded',
        output: proposal,
      }],
    }),
    startStep: vi.fn(),
    completeStep: vi.fn(),
    failStep: vi.fn(),
    completeJob: vi.fn().mockRejectedValue(new Error('cannot succeed cancelled job')),
    validateProposal: vi.fn(),
  }
  const generateBoundaries = vi.fn()

  await expect(runTextVideoSplitJob(31, { api, generateBoundaries }))
    .resolves.toEqual(proposal)

  expect(api.completeJob).not.toHaveBeenCalled()
  expect(generateBoundaries).not.toHaveBeenCalled()
  expect(api.validateProposal).not.toHaveBeenCalled()
  expect(api.startStep).not.toHaveBeenCalled()
  expect(api.completeStep).not.toHaveBeenCalled()
  expect(api.failStep).not.toHaveBeenCalled()
})

it('does not fail an already-succeeded step when job finalization fails', async () => {
  const api = {
    getJob: vi.fn().mockResolvedValue({
      id: 31,
      flow: 'text_video_split_preview',
      status: 'queued',
      input: {
        project_id: 7,
        script: '甲。乙。',
        script_hash: 'a'.repeat(64),
        direction: '',
        candidates: [],
      },
      steps: [],
    }),
    startStep: vi.fn().mockResolvedValue({ id: 41 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockRejectedValue(new Error('job finalization unavailable')),
    validateProposal: vi.fn().mockResolvedValue({
      segments: [
        { id: 'segment-a', text: '甲。乙。', estimated_duration: 1, reason: 'AI 建议分段' },
      ],
      speech_split_mode: 'auto' as const,
    }),
  }
  const generateBoundaries = vi.fn().mockResolvedValue({ boundaries: [] })

  await expect(runTextVideoSplitJob(31, { api, generateBoundaries }))
    .rejects.toThrow('步骤结果已保存，等待任务状态对账')

  expect(api.completeStep).toHaveBeenCalledOnce()
  expect(api.failStep).not.toHaveBeenCalled()
})
