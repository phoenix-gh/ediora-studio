import { expect, it, vi } from 'vitest'

import {
  makeGlobalWords,
  makeScenePlan,
  makeTextVideoProject,
} from '@/lib/text-video/test-fixtures'

import {
  motionProposalSchema,
  runTextVideoSceneJob,
  sceneProposalSchema,
  type TextVideoSceneJobDeps,
} from './text-video-scene-job'


const validProposal = {
  scenes: [{
    id: 'scene-1',
    fromWordId: 'word-1',
    throughWordId: 'word-3',
    displayText: '做 AI 视频',
    highlight: ['AI'],
    animation: 'fade-up',
  }],
}
const validatedProposal = {
  ...validProposal,
  validation_token: 'e'.repeat(64),
}

const motionProposal = {
  scenes: [{
    ...validProposal.scenes[0],
    animation: 'impact' as const,
    motion: {
      transition: 'block-wipe' as const,
      intensity: 0.8,
      chunks: [{
        id: 'scene-1-chunk-1',
        fromWordId: 'word-1',
        throughWordId: 'word-3',
        displayText: '做 AI 视频',
        highlight: ['AI'],
        motionPreset: 'impact' as const,
        emphasis: 'punch' as const,
      }],
    },
  }],
}

const readyProject = makeTextVideoProject({
  scene_plan: makeScenePlan({
    status: 'ready',
    generation_revision: 2,
    master_source_hash: 'a'.repeat(64),
    scenes: validProposal.scenes,
    job_id: null,
    applied_job_id: 41,
  } as never),
})

function makeQueuedJob() {
  return {
    id: 41,
    flow: 'text_video_scene_plan',
    title: '生成文字视频分镜',
    status: 'queued',
    input: {
      project_id: 1,
      master_source_hash: 'a'.repeat(64),
      timeline_fingerprint: 'b'.repeat(64),
      scene_generation_revision: 1,
      template_id: 'tech-text-v1',
      template_version: 1,
      manifest_digest: 'c'.repeat(64),
      existing_scenes_digest: 'd'.repeat(64),
    },
    steps: [],
  }
}

function makeSceneContext() {
  return {
    project_id: 1,
    master_source_hash: 'a'.repeat(64),
    timeline_fingerprint: 'b'.repeat(64),
    scene_generation_revision: 1,
    script: '做 AI 视频',
    words: makeGlobalWords(['做', ' AI', ' 视频']),
    speech_segments: [{
      id: 'segment-1',
      fromWordId: 'word-1',
      throughWordId: 'word-3',
    }],
    template: {
      id: 'tech-text-v1',
      version: 1,
      animations: ['fade-up', 'scale'],
      transitions: ['soft-push'],
    },
    existing_scenes: [],
    scope: 'all' as const,
    selected_scene_id: '',
    direction: '',
  }
}

function makeRunningJob() {
  return {
    ...makeQueuedJob(),
    status: 'running',
    steps: [{
      id: 51,
      key: 'generate_scene_plan',
      attempt: 1,
      status: 'running',
      output: {},
    }],
  }
}

function sceneApiError(
  status: number,
  detail: unknown,
  retryable = false,
) {
  return Object.assign(new Error(
    typeof detail === 'string' ? detail : '分镜请求失败',
  ), {
    status,
    detail,
    retryable,
    responseReceived: true,
  })
}

function makeSceneJobDeps(): TextVideoSceneJobDeps {
  return {
    generate: vi.fn().mockResolvedValue(validProposal),
    api: {
      getJob: vi.fn().mockResolvedValue(makeQueuedJob()),
      startStep: vi.fn().mockResolvedValue({ id: 51, attempt: 1 }),
      completeStep: vi.fn().mockResolvedValue({}),
      failStep: vi.fn().mockResolvedValue({}),
      completeJob: vi.fn().mockResolvedValue({}),
      getSceneContext: vi.fn().mockResolvedValue(makeSceneContext()),
      validateScenePlan: vi.fn().mockResolvedValue(validatedProposal),
      persistScenePlan: vi.fn().mockResolvedValue(readyProject),
      failScenePlan: vi.fn().mockResolvedValue({}),
    },
  }
}

it('asks AI for word IDs only and persists the server-validated proposal', async () => {
  const deps = makeSceneJobDeps()

  await expect(runTextVideoSceneJob(41, deps)).resolves.toEqual(readyProject)

  expect(deps.generate).toHaveBeenCalledOnce()
  const generation = vi.mocked(deps.generate).mock.calls[0][0]
  expect(generation.schema).toBeDefined()
  expect(generation.prompt).toContain('"fromWordId"')
  expect(generation.prompt).not.toContain('"start":')
  expect(generation.prompt).not.toContain('"end":')
  expect(deps.api.validateScenePlan).toHaveBeenCalledWith(
    1,
    validProposal,
    41,
    expect.objectContaining({
      step_id: 51,
      attempt: 1,
      claim_token: expect.any(String),
    }),
  )
  expect(deps.api.persistScenePlan).toHaveBeenCalledWith(
    1,
    validatedProposal,
    41,
    expect.objectContaining({
      step_id: 51,
      attempt: 1,
      claim_token: expect.any(String),
    }),
  )
  expect(deps.api.completeStep).toHaveBeenCalledWith(
    41,
    51,
    { project: readyProject },
  )
  expect(deps.api.completeJob).toHaveBeenCalledWith(41)
})

it('uses the strict motion schema and freezes scene copy without timestamps', async () => {
  const deps = makeSceneJobDeps()
  const context = {
    ...makeSceneContext(),
    generation_mode: 'motion' as const,
    template: {
      id: 'kinetic-punch-v2',
      version: 1,
      animations: ['impact', 'reveal', 'contrast'],
      transitions: ['block-wipe'],
    },
    existing_scenes: [motionProposal.scenes[0]],
  }
  vi.mocked(deps.api.getSceneContext).mockResolvedValue(context)
  vi.mocked(deps.generate).mockResolvedValue(motionProposal)
  vi.mocked(deps.api.validateScenePlan).mockResolvedValue({
    ...motionProposal,
    validation_token: 'e'.repeat(64),
  })

  await runTextVideoSceneJob(41, deps)

  const generation = vi.mocked(deps.generate).mock.calls[0][0]
  expect(generation.schema).toBe(motionProposalSchema)
  expect(generation.prompt).toContain('顶层分镜字段必须原样保留')
  expect(generation.prompt).toContain('"fromWordId":"word-1"')
  expect(generation.prompt).not.toContain('"start"')
  expect(generation.prompt).not.toContain('"end"')
  expect(motionProposalSchema.safeParse(motionProposal).success).toBe(true)
})

it('repairs one invalid motion proposal with the motion schema', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getSceneContext).mockResolvedValue({
    ...makeSceneContext(),
    generation_mode: 'motion',
    template: {
      id: 'kinetic-punch-v2',
      version: 1,
      animations: ['impact', 'reveal', 'contrast'],
      transitions: ['block-wipe'],
    },
    existing_scenes: [motionProposal.scenes[0]],
  })
  vi.mocked(deps.generate)
    .mockResolvedValueOnce(motionProposal)
    .mockResolvedValueOnce(motionProposal)
  vi.mocked(deps.api.validateScenePlan)
    .mockRejectedValueOnce(sceneApiError(422, '文字被修改'))
    .mockResolvedValueOnce({
      ...motionProposal,
      validation_token: 'e'.repeat(64),
    })

  await runTextVideoSceneJob(41, deps)

  expect(deps.generate).toHaveBeenCalledTimes(2)
  expect(vi.mocked(deps.generate).mock.calls[1][0].schema)
    .toBe(motionProposalSchema)
  expect(vi.mocked(deps.generate).mock.calls[1][0].prompt)
    .toContain('文字被修改')
})

it('uses prompt JSON without unsupported response_format for compatible providers', async () => {
  const previousToken = process.env.WMS_WORKER_TOKEN
  process.env.WMS_WORKER_TOKEN = 'worker-token-at-least-32-characters'
  const json = (value: unknown) => new Response(
    JSON.stringify(value),
    { headers: { 'Content-Type': 'application/json' } },
  )
  const fetchMock = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    if (url.endsWith('/jobs/41') && !init?.method) {
      return json(makeQueuedJob())
    }
    if (url.endsWith('/steps/generate_scene_plan/start')) {
      return json({ id: 51, attempt: 1 })
    }
    if (url.endsWith('/scene-plan/worker-context')) {
      return json(makeSceneContext())
    }
    if (url.endsWith('/settings/ai-runtime')) {
      return json({
        api_key: 'test-key',
        model: 'deepseek-v4-flash',
        base_url: 'https://api.deepseek.com',
      })
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      return json({
        id: 'scene-provider-1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(validProposal),
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      })
    }
    if (url.endsWith('/scene-plan/worker-validate')) {
      return json(validatedProposal)
    }
    if (url.endsWith('/scene-plan/worker-result')) {
      return json(readyProject)
    }
    if (
      url.endsWith('/steps/51/succeed')
      || url.endsWith('/jobs/41/succeed')
    ) {
      return json({})
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  try {
    await expect(runTextVideoSceneJob(41)).resolves.toEqual(readyProject)
  } finally {
    vi.unstubAllGlobals()
    if (previousToken === undefined) delete process.env.WMS_WORKER_TOKEN
    else process.env.WMS_WORKER_TOKEN = previousToken
  }

  const providerCall = fetchMock.mock.calls.find(
    ([input]) => String(input) === 'https://api.deepseek.com/chat/completions',
  )
  expect(providerCall).toBeDefined()
  const requestBody = JSON.parse(String(providerCall?.[1]?.body))
  expect(requestBody.response_format).toBeUndefined()
})

it('repairs one 422 with the exact invalid JSON and validation detail', async () => {
  const deps = makeSceneJobDeps()
  const invalid = {
    scenes: [{ ...validProposal.scenes[0], fromWordId: 'missing-word' }],
  }
  vi.mocked(deps.generate)
    .mockResolvedValueOnce(invalid)
    .mockResolvedValueOnce(validProposal)
  vi.mocked(deps.api.validateScenePlan)
    .mockRejectedValueOnce(sceneApiError(
      422,
      {
        message: '分镜词范围必须完整且连续',
        errors: ['missing-word 不存在'],
      },
    ))
    .mockResolvedValueOnce(validatedProposal)

  await runTextVideoSceneJob(41, deps)

  expect(deps.generate).toHaveBeenCalledTimes(2)
  const repairPrompt = vi.mocked(deps.generate).mock.calls[1][0].prompt
  expect(repairPrompt).toContain('分镜词范围必须完整且连续')
  expect(repairPrompt).toContain('missing-word 不存在')
  expect(repairPrompt).toContain(JSON.stringify(invalid))
})

it('fails after exactly one repair and preserves a nonretryable validation failure', async () => {
  const deps = makeSceneJobDeps()
  const invalid = {
    scenes: [{ ...validProposal.scenes[0], fromWordId: 'missing-word' }],
  }
  vi.mocked(deps.generate).mockResolvedValue(invalid)
  vi.mocked(deps.api.validateScenePlan).mockRejectedValue(
    sceneApiError(422, '分镜词范围必须完整且连续'),
  )

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('AI 分镜连续两次未通过校验')

  expect(deps.generate).toHaveBeenCalledTimes(2)
  expect(deps.api.failScenePlan).toHaveBeenCalledWith(
    1,
    'AI 分镜连续两次未通过校验',
    41,
    expect.objectContaining({
      step_id: 51,
      attempt: 1,
      claim_token: expect.any(String),
    }),
  )
  expect(deps.api.failStep).toHaveBeenCalledWith(
    41,
    51,
    expect.any(Error),
    false,
  )
  expect(deps.api.persistScenePlan).not.toHaveBeenCalled()
})

it('does not repair or mutate domain state after a stale 409', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.validateScenePlan).mockRejectedValue(
    sceneApiError(409, '主音频时间轴已更新'),
  )

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('主音频时间轴已更新')

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.persistScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).toHaveBeenCalledWith(
    41,
    51,
    expect.any(Error),
    false,
  )
})

it('preserves the original stale error when failStep also conflicts', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.validateScenePlan).mockRejectedValue(
    sceneApiError(409, '主音频时间轴已更新'),
  )
  vi.mocked(deps.api.failStep).mockRejectedValue(
    sceneApiError(409, '任务已取消'),
  )

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('主音频时间轴已更新')

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
})

it('recovers a succeeded durable scene step without AI or persistence replay', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob).mockResolvedValue({
    ...makeQueuedJob(),
    status: 'running',
    steps: [{
      id: 51,
      key: 'generate_scene_plan',
      attempt: 1,
      status: 'succeeded',
      output: { project: readyProject },
    }],
  })

  await expect(runTextVideoSceneJob(41, deps)).resolves.toEqual(readyProject)

  expect(deps.generate).not.toHaveBeenCalled()
  expect(deps.api.getSceneContext).not.toHaveBeenCalled()
  expect(deps.api.validateScenePlan).not.toHaveBeenCalled()
  expect(deps.api.persistScenePlan).not.toHaveBeenCalled()
  expect(deps.api.startStep).not.toHaveBeenCalled()
  expect(deps.api.completeStep).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
  expect(deps.api.completeJob).toHaveBeenCalledWith(41)
})

it('rejects a succeeded step output whose project or applied provenance is wrong', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob).mockResolvedValue({
    ...makeQueuedJob(),
    status: 'running',
    steps: [{
      id: 51,
      key: 'generate_scene_plan',
      attempt: 1,
      status: 'succeeded',
      output: {
        project: {
          ...readyProject,
          id: 2,
          scene_plan: {
            ...readyProject.scene_plan,
            applied_job_id: 99,
          },
        },
      },
    }],
  })

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('已完成的 AI 分镜结果无效')

  expect(deps.generate).not.toHaveBeenCalled()
  expect(deps.api.completeJob).not.toHaveBeenCalled()
})

it('persists exactly the server-canonical selected-scene merge', async () => {
  const deps = makeSceneJobDeps()
  const existing = [
    validProposal.scenes[0],
    {
      id: 'scene-2',
      fromWordId: 'word-4',
      throughWordId: 'word-5',
      displayText: '保持不变',
      highlight: [],
      animation: 'scale',
    },
  ]
  const selectedRaw = {
    scenes: [{
      ...validProposal.scenes[0],
      displayText: '强调 AI',
      highlight: ['AI'],
      animation: 'scale',
    }],
  }
  const canonical = {
    scenes: [selectedRaw.scenes[0], existing[1]],
    validation_token: 'f'.repeat(64),
  }
  vi.mocked(deps.api.getSceneContext).mockResolvedValue({
    ...makeSceneContext(),
    scope: 'selected',
    selected_scene_id: 'scene-1',
    existing_scenes: existing,
  })
  vi.mocked(deps.generate).mockResolvedValue(selectedRaw)
  vi.mocked(deps.api.validateScenePlan).mockResolvedValue(canonical)

  await runTextVideoSceneJob(41, deps)

  expect(deps.api.persistScenePlan).toHaveBeenCalledWith(
    1,
    canonical,
    41,
    expect.objectContaining({
      step_id: 51,
      attempt: 1,
      claim_token: expect.any(String),
    }),
  )
})

it('binds every protected scene request to one durable step claim', async () => {
  const deps = Object.assign(makeSceneJobDeps(), {
    createClaimToken: () => 'claim-token-1234567890',
  })

  await runTextVideoSceneJob(41, deps)

  const claim = {
    step_id: 51,
    attempt: 1,
    claim_token: 'claim-token-1234567890',
  }
  expect(deps.api.getSceneContext).toHaveBeenCalledWith(1, 41, claim)
  expect(deps.api.validateScenePlan).toHaveBeenCalledWith(
    1,
    validProposal,
    41,
    claim,
  )
  expect(deps.api.persistScenePlan).toHaveBeenCalledWith(
    1,
    validatedProposal,
    41,
    claim,
  )
})

it('strictly rejects AI timing fields instead of silently stripping them', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.generate).mockResolvedValue({
    scenes: [{
      ...validProposal.scenes[0],
      start: 0,
      end: 1,
    }],
  } as never)

  await expect(runTextVideoSceneJob(41, deps)).rejects.toThrow()

  expect(sceneProposalSchema.safeParse({
    scenes: [{
      ...validProposal.scenes[0],
      start: 0,
      end: 1,
    }],
  }).success).toBe(false)
  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.validateScenePlan).not.toHaveBeenCalled()
  expect(deps.api.persistScenePlan).not.toHaveBeenCalled()
})

it.each([
  [401, 'worker token 无效'],
  [429, '请求过于频繁'],
  [503, 'AI 服务不可用'],
  [undefined, 'network unavailable'],
] as const)(
  'does not repair validation transport/status %s',
  async (status, detail) => {
    const deps = makeSceneJobDeps()
    const error = status === undefined
      ? new Error(detail)
      : sceneApiError(status, detail, status === 429 || status === 503)
    vi.mocked(deps.api.validateScenePlan).mockRejectedValue(error)

    await expect(runTextVideoSceneJob(41, deps)).rejects.toThrow(detail)

    expect(deps.generate).toHaveBeenCalledOnce()
    expect(deps.api.persistScenePlan).not.toHaveBeenCalled()
  },
)

it('never repairs a 422 returned by worker-result persistence', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.persistScenePlan).mockRejectedValue(
    sceneApiError(422, '结果提交时场景已不再有效'),
  )

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('结果提交时场景已不再有效')

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.validateScenePlan).toHaveBeenCalledOnce()
  expect(deps.api.persistScenePlan).toHaveBeenCalledOnce()
  expect(deps.api.getSceneContext).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).toHaveBeenCalledWith(
    1,
    '结果提交时场景已不再有效',
    41,
    expect.any(Object),
  )
  expect(deps.api.failStep).toHaveBeenCalledWith(
    41,
    51,
    expect.any(Error),
    false,
  )
})

it('recovers a persisted result after worker-result loses its acknowledgement', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getSceneContext)
    .mockResolvedValueOnce(makeSceneContext())
    .mockResolvedValueOnce({ already_saved: readyProject } as never)
  vi.mocked(deps.api.persistScenePlan).mockRejectedValue(
    new Error('worker-result connection reset'),
  )

  await expect(runTextVideoSceneJob(41, deps)).resolves.toEqual(readyProject)

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.getSceneContext).toHaveBeenCalledTimes(2)
  expect(deps.api.completeStep).toHaveBeenCalledWith(
    41,
    51,
    { project: readyProject },
  )
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('reconciles completeStep acknowledgement loss without rerunning AI', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockResolvedValueOnce({
      ...makeQueuedJob(),
      status: 'running',
      steps: [{
        id: 51,
        key: 'generate_scene_plan',
        attempt: 1,
        status: 'succeeded',
        output: { project: readyProject },
      }],
    })
  vi.mocked(deps.api.completeStep).mockRejectedValue(
    new Error('completeStep connection reset'),
  )

  await expect(runTextVideoSceneJob(41, deps)).resolves.toEqual(readyProject)

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.completeStep).toHaveBeenCalledOnce()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('does not reconcile completeStep against a different step attempt', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockResolvedValueOnce({
      ...makeQueuedJob(),
      status: 'running',
      steps: [{
        id: 99,
        key: 'generate_scene_plan',
        attempt: 2,
        status: 'succeeded',
        output: { project: readyProject },
      }],
    })
  vi.mocked(deps.api.completeStep).mockRejectedValue(
    new Error('completeStep connection reset'),
  )

  await expect(runTextVideoSceneJob(41, deps)).rejects.toMatchObject({
    name: 'JobFinalizationError',
    message: 'AI 分镜步骤结果可能已保存，等待状态对账',
  })

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.completeJob).not.toHaveBeenCalled()
})

it('replays an ambiguous domain failure acknowledgement without rerunning AI', async () => {
  const deps = makeSceneJobDeps()
  const providerError = new Error('provider unavailable')
  vi.mocked(deps.generate).mockRejectedValue(providerError)
  vi.mocked(deps.api.failScenePlan)
    .mockRejectedValueOnce(new Error('failure acknowledgement lost'))
    .mockResolvedValueOnce({})

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('provider unavailable')

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).toHaveBeenCalledTimes(2)
  expect(deps.api.failStep).toHaveBeenCalledWith(
    41,
    51,
    providerError,
    true,
  )
})

it('reconciles failStep acknowledgement loss without rerunning AI', async () => {
  const deps = makeSceneJobDeps()
  const providerError = new Error('provider unavailable')
  vi.mocked(deps.generate).mockRejectedValue(providerError)
  vi.mocked(deps.api.failStep).mockRejectedValue(
    new Error('failStep connection reset'),
  )
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockResolvedValueOnce({
      ...makeQueuedJob(),
      status: 'failed',
      steps: [{
        id: 51,
        key: 'generate_scene_plan',
        attempt: 1,
        status: 'failed',
        output: {},
      }],
    })

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toBe(providerError)

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).toHaveBeenCalledOnce()
  expect(deps.api.failStep).toHaveBeenCalledOnce()
  expect(deps.api.getJob).toHaveBeenCalledTimes(2)
})

it('fails closed when failStep acknowledgement cannot be confirmed', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.generate).mockRejectedValue(
    new Error('provider unavailable'),
  )
  vi.mocked(deps.api.failStep).mockRejectedValue(
    new Error('failStep connection reset'),
  )
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockResolvedValueOnce({
      ...makeQueuedJob(),
      status: 'running',
      steps: [{
        id: 51,
        key: 'generate_scene_plan',
        attempt: 1,
        status: 'running',
        output: {},
      }],
    })

  await expect(runTextVideoSceneJob(41, deps)).rejects.toMatchObject({
    name: 'JobFinalizationError',
    message: 'AI 分镜失败步骤状态无法确认，等待状态对账',
  })

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failStep).toHaveBeenCalledOnce()
})

it('fails closed on an already-running durable step without a second paid call', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob).mockResolvedValue({
    ...makeQueuedJob(),
    status: 'running',
    steps: [{
      id: 51,
      key: 'generate_scene_plan',
      attempt: 1,
      status: 'running',
      output: {},
    }],
  })

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('正在由其他 worker 执行')

  expect(deps.generate).not.toHaveBeenCalled()
  expect(deps.api.getSceneContext).not.toHaveBeenCalled()
  expect(deps.api.startStep).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('recovers a durable running step after startStep acknowledgement loss', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockResolvedValueOnce(makeRunningJob())
  vi.mocked(deps.api.startStep).mockRejectedValue(
    new Error('startStep connection reset'),
  )

  await expect(runTextVideoSceneJob(41, deps)).resolves.toEqual(
    readyProject,
  )

  expect(deps.api.startStep).toHaveBeenCalledOnce()
  expect(deps.api.getJob).toHaveBeenCalledTimes(2)
  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('reconciles a durable running step after an ambiguous startStep 503', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockResolvedValueOnce(makeRunningJob())
  vi.mocked(deps.api.startStep).mockRejectedValue(
    sceneApiError(503, 'gateway timeout after commit', true),
  )

  await expect(runTextVideoSceneJob(41, deps)).resolves.toEqual(
    readyProject,
  )

  expect(deps.api.getJob).toHaveBeenCalledTimes(2)
  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('fails closed when startStep acknowledgement reconciliation cannot read the job', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getJob)
    .mockResolvedValueOnce(makeQueuedJob())
    .mockRejectedValueOnce(new Error('job status read failed'))
  vi.mocked(deps.api.startStep).mockRejectedValue(
    new Error('startStep connection reset'),
  )

  await expect(runTextVideoSceneJob(41, deps)).rejects.toMatchObject({
    name: 'JobFinalizationError',
    message: 'AI 分镜步骤启动状态无法确认，等待状态对账',
  })

  expect(deps.generate).not.toHaveBeenCalled()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('does not reconcile a definite startStep HTTP response as acknowledgement loss', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.startStep).mockRejectedValue(
    sceneApiError(409, '步骤已在运行'),
  )

  await expect(runTextVideoSceneJob(41, deps))
    .rejects.toThrow('步骤已在运行')

  expect(deps.api.getJob).toHaveBeenCalledOnce()
  expect(deps.generate).not.toHaveBeenCalled()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('turns a typed scene claim conflict into pending without failing domain state', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getSceneContext).mockRejectedValue(
    sceneApiError(409, {
      code: 'scene_claim_conflict',
      message: 'AI 分镜步骤已被其他 worker 领取',
    }),
  )

  await expect(runTextVideoSceneJob(41, deps)).rejects.toMatchObject({
    name: 'SceneJobPendingError',
  })

  expect(deps.generate).not.toHaveBeenCalled()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})

it('lets only the database claim winner call AI after two lost start acknowledgements', async () => {
  const sharedGenerate = vi.fn().mockResolvedValue(validProposal)
  let owner = ''
  const getSceneContext = vi.fn().mockImplementation(
    async (
      _projectId: number,
      _jobId: number,
      claim: { claim_token: string },
    ) => {
      if (!owner) {
        owner = claim.claim_token
        return makeSceneContext()
      }
      if (owner === claim.claim_token) return makeSceneContext()
      throw sceneApiError(409, {
        code: 'scene_claim_conflict',
        message: 'AI 分镜步骤已被其他 worker 领取',
      })
    },
  )
  const failScenePlan = vi.fn().mockResolvedValue({})
  const failStep = vi.fn().mockResolvedValue({})

  function competingDeps(claimToken: string) {
    const deps = makeSceneJobDeps()
    deps.generate = sharedGenerate
    deps.createClaimToken = () => claimToken
    vi.mocked(deps.api.getJob)
      .mockResolvedValueOnce(makeQueuedJob())
      .mockResolvedValueOnce(makeRunningJob())
    vi.mocked(deps.api.startStep).mockRejectedValue(
      new Error('startStep connection reset'),
    )
    deps.api.getSceneContext = getSceneContext
    deps.api.failScenePlan = failScenePlan
    deps.api.failStep = failStep
    return deps
  }

  const outcomes = await Promise.allSettled([
    runTextVideoSceneJob(41, competingDeps('claim-token-worker-one')),
    runTextVideoSceneJob(41, competingDeps('claim-token-worker-two')),
  ])

  expect(outcomes.filter(result => result.status === 'fulfilled'))
    .toHaveLength(1)
  const rejected = outcomes.find(result => result.status === 'rejected')
  expect(rejected).toMatchObject({
    status: 'rejected',
    reason: { name: 'SceneJobPendingError' },
  })
  expect(sharedGenerate).toHaveBeenCalledOnce()
  expect(failScenePlan).not.toHaveBeenCalled()
  expect(failStep).not.toHaveBeenCalled()
})

it('throws finalization uncertainty when persisted-result reconciliation read fails', async () => {
  const deps = makeSceneJobDeps()
  vi.mocked(deps.api.getSceneContext)
    .mockResolvedValueOnce(makeSceneContext())
    .mockRejectedValueOnce(new Error('scene context read failed'))
  vi.mocked(deps.api.persistScenePlan).mockRejectedValue(
    new Error('worker-result connection reset'),
  )

  await expect(runTextVideoSceneJob(41, deps)).rejects.toMatchObject({
    name: 'JobFinalizationError',
    message: 'AI 分镜结果状态无法确认，等待状态对账',
  })

  expect(deps.generate).toHaveBeenCalledOnce()
  expect(deps.api.failScenePlan).not.toHaveBeenCalled()
  expect(deps.api.failStep).not.toHaveBeenCalled()
})
