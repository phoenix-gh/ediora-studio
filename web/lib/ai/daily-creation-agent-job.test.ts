import { describe, expect, it, vi } from 'vitest'

import {
  buildDailyCreationAgentObjective,
  firstBlockingToolAudit,
  runDailyCreationAgentJob,
  type DailyCreationAgentContext,
  type DailyCreationAgentJobDependencies,
} from './daily-creation-agent-job'
import type { AgentToolAudit } from './agent-runtime-types'

const prompt = '检查今天的 GitHub 日榜，并把结论保存到临时文件。'

function audit(
  toolName: string,
  status: AgentToolAudit['status'],
  sideEffecting: boolean,
): AgentToolAudit {
  return {
    toolName,
    toolCallId: `${toolName}-${status}`,
    sideEffecting,
    autoApproved: true,
    status,
    inputSummary: {},
    occurredAt: '2026-08-12T00:00:00Z',
  }
}

const context: DailyCreationAgentContext = {
  id: 83,
  status: 'queued',
  requested_count: 0,
  rule: {
    name: '日报',
    prompt,
    asset_type: 'article',
    output_type: 'x_short_post',
    target_count: 0,
    lookback_days: 0,
    delivery_mode: 'drafts',
    skill_mode: 'auto',
  },
}

const jobCapabilitySnapshot = {
  schemaVersion: 1 as const,
  mode: 'job' as const,
  skill: null,
  tools: [],
  policy: { approvalPolicy: 'automatic' as const, allowedToolNames: null },
}

type DependencyOptions = {
  text?: string
  toolAudits?: AgentToolAudit[]
  finishReason?: string
  stepCount?: number
}

function dependencies({
  text = '研究完成',
  toolAudits = [],
  finishReason = 'stop',
  stepCount = 1,
}: DependencyOptions = {}) {
  const execution = {
    id: 41, job_id: 19, status: 'running', objective: prompt,
    skill_mode: 'auto' as const, skill_name: null, phase: 'created',
    checkpoint: {}, audit: {}, completion_evidence: {}, version: 1,
  }
  const runtimeRun = vi.fn().mockImplementation(async request => {
    await request.onStep?.({ phase: 'execute', parts: [{ type: 'text', text }] })
    for (const audit of toolAudits) await runtimeOptions?.onToolAudit?.(audit)
    return {
      kind: 'completed' as const, text, parts: [], revisionCount: 0,
      finishReason, stepCount,
    }
  })
  let runtimeOptions: Parameters<DailyCreationAgentJobDependencies['openRuntime']>[0] | undefined
  const deps: DailyCreationAgentJobDependencies = {
    getJob: vi.fn().mockResolvedValue({
      id: 19, flow: 'daily_creation', title: 'daily', status: 'queued',
      input: { run_id: 83 }, steps: [],
    }),
    getContext: vi.fn().mockResolvedValue(context),
    loadModel: vi.fn().mockResolvedValue({}),
    ensureExecution: vi.fn().mockResolvedValue(execution),
    checkpointExecution: vi.fn().mockImplementation(async (_jobId, _id, version, update) => ({
      ...execution, version: version + 1, phase: update.phase,
      checkpoint: update.checkpoint, audit: update.audit,
    })),
    claimToolCall: vi.fn().mockResolvedValue({ action: 'execute' }),
    listToolCalls: vi.fn().mockResolvedValue([]),
    completeToolCall: vi.fn().mockResolvedValue({}),
    failToolCall: vi.fn().mockResolvedValue({}),
    failExecution: vi.fn().mockResolvedValue({}),
    completeExecution: vi.fn().mockResolvedValue({}),
    startStep: vi.fn().mockResolvedValue({ id: 71, attempt: 1 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockResolvedValue({}),
    apiRoot: () => 'http://api.test',
    openRuntime: vi.fn().mockImplementation(async options => {
      runtimeOptions = options
      return {
        tools: {}, catalogContext: '', selectedSkill: undefined,
        prepare: vi.fn(), snapshot: () => ({}), activeContext: () => undefined,
        capabilitySnapshot: () => jobCapabilitySnapshot,
        readReferences: vi.fn(), close: vi.fn(), run: runtimeRun,
      }
    }),
  }
  return { deps, runtimeRun }
}

describe('daily creation Agent job', () => {
  it('reports the unresolved failure after a recovered read-only failure', () => {
    const failed = audit('list_creative_asset_candidates', 'failed', false)
    const recovered = audit('list_creative_asset_candidates', 'succeeded', false)
    const unresolved = audit('generateImage', 'failed', false)

    expect(firstBlockingToolAudit([failed, recovered, unresolved])).toBe(unresolved)
  })

  it('keeps an unrecovered read-only failure blocking', () => {
    expect(firstBlockingToolAudit([audit('read', 'failed', false)]))
      .toMatchObject({ toolName: 'read', status: 'failed' })
  })

  it('never recovers side-effecting failures or uncertain audits', () => {
    expect(firstBlockingToolAudit([
      audit('write', 'failed', true),
      audit('write', 'succeeded', true),
    ])).toMatchObject({ toolName: 'write', status: 'failed' })
    expect(firstBlockingToolAudit([
      audit('read', 'uncertain', false),
      audit('read', 'succeeded', false),
    ])).toMatchObject({ toolName: 'read', status: 'uncertain' })
  })

  it('surfaces the first unresolved tool failure at the job boundary', async () => {
    const { deps } = dependencies({ toolAudits: [
      audit('list_creative_asset_candidates', 'failed', false),
      audit('list_creative_asset_candidates', 'succeeded', false),
      audit('generateImage', 'failed', false),
    ] })

    await expect(runDailyCreationAgentJob(19, deps))
      .rejects.toThrow('Agent tool audit is failed: generateImage')
  })

  it('finalizes the canonical turn and fails the Job when the model errors', async () => {
    const { deps, runtimeRun } = dependencies()
    const sessionEvents: Array<Record<string, unknown>> = []
    runtimeRun.mockRejectedValue(new Error('LLM 接口失败'))
    deps.appendSessionEvent = vi.fn(async (_jobId, _executionId, event) => { sessionEvents.push(event as Record<string, unknown>) })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow('LLM 接口失败')

    expect(deps.failExecution).toHaveBeenCalledWith(19, 41, expect.stringContaining('LLM 接口失败'))
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), true)
    expect(sessionEvents.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: 'LLM 接口失败' } },
    })
  })

  it('records Job session, Skill, capability, and turn events', async () => {
    const { deps } = dependencies()
    const events: Array<Record<string, unknown>> = []
    const sessionEvents: Array<Record<string, unknown>> = []
    deps.appendLogEvent = vi.fn(async (_jobId, event) => { events.push(event as Record<string, unknown>) })
    deps.appendSessionEvent = vi.fn(async (_jobId, _executionId, event) => { sessionEvents.push(event as Record<string, unknown>) })

    await runDailyCreationAgentJob(19, deps)

    expect(events.map(event => event.event_type)).toEqual([
      'session/turn-start',
      'skill/selected',
      'session/capabilities',
      'session/turn-end',
    ])
    expect(sessionEvents.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'agent/skill', 'turn/end',
    ])
  })

  it('passes the saved prompt to the Agent without business instructions', () => {
    expect(buildDailyCreationAgentObjective({
      id: 83,
      status: 'queued',
      rule: { name: '日报', prompt },
    })).toBe(prompt)
  })

  it('rejects a blank saved prompt', () => {
    expect(() => buildDailyCreationAgentObjective({
      id: 83,
      status: 'queued',
      rule: { name: '日报', prompt: '   ' },
    })).toThrow('scheduled Agent prompt is blank')
  })

  it('rejects a blank worker context before opening an execution or runtime', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.getContext).mockResolvedValue({
      ...context,
      rule: { ...context.rule, prompt: '   ' },
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'scheduled Agent prompt is blank',
    )
    expect(deps.ensureExecution).not.toHaveBeenCalled()
    expect(deps.loadModel).not.toHaveBeenCalled()
    expect(deps.openRuntime).not.toHaveBeenCalled()
  })

  it('completes a text-only generic Agent run', async () => {
    const { deps, runtimeRun } = dependencies({ text: '研究完成', toolAudits: [] })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run',
      executionId: 41,
      finalText: '研究完成',
      toolCallCount: 0,
    })
    expect(deps.completeJob).toHaveBeenCalledWith(19)
    expect(runtimeRun).toHaveBeenCalledWith(expect.objectContaining({ objective: prompt }))
    expect(deps.openRuntime).toHaveBeenCalledWith(expect.objectContaining({
      dailyCreationRunId: 83, mode: 'job', policyProfile: 'scheduled',
    }))
    expect(deps.checkpointExecution).toHaveBeenCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'prepared',
        audit: expect.objectContaining({ capabilities: jobCapabilitySnapshot }),
      }),
    )
    expect(deps.checkpointExecution).toHaveBeenLastCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'finalizing',
        audit: expect.objectContaining({ capabilities: jobCapabilitySnapshot }),
      }),
    )
    expect(runtimeRun.mock.calls[0]?.[0]?.requiredTools).toBeUndefined()
    expect(runtimeRun.mock.calls[0]?.[0]?.selectedContext).toBeUndefined()
  })

  it('rejects a retry before Agent execution when the pinned capabilities drift', async () => {
    const { deps, runtimeRun } = dependencies()
    vi.mocked(deps.ensureExecution).mockResolvedValue({
      id: 41, job_id: 19, status: 'running', objective: prompt,
      skill_mode: 'auto', skill_name: null, phase: 'finalizing', version: 3,
      checkpoint: {}, audit: {}, completion_evidence: {},
      capability_pin: {
        ...jobCapabilitySnapshot,
        tools: [{
          name: 'new_tool', description: '', inputSchemaDigest: null,
          sideEffecting: false, needsApproval: false, replayPolicy: 'replayable',
          concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown',
        }],
      },
    })

    await expect(runDailyCreationAgentJob(19, deps))
      .rejects.toThrow('Agent capability drift detected: tools')
    expect(runtimeRun).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
  })

  it('bounds generic evidence text and persists it in a finalizing checkpoint', async () => {
    const { deps } = dependencies({ text: 'x'.repeat(2_100) })

    const evidence = await runDailyCreationAgentJob(19, deps)

    expect(evidence).toMatchObject({
      kind: 'agent_run', executionId: 41, finalText: 'x'.repeat(2_000), toolCallCount: 0,
    })
    expect(deps.checkpointExecution).toHaveBeenLastCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'finalizing',
        checkpoint: expect.objectContaining({ evidence }),
      }),
    )
  })

  it('rejects a run with an uncertain tool audit', async () => {
    const { deps } = dependencies({ toolAudits: [{
      toolName: 'write_file', toolCallId: 'tool-1', sideEffecting: false,
      autoApproved: true, status: 'uncertain', inputSummary: {},
      error: 'connection lost', occurredAt: '2026-08-09T00:00:00Z',
    }] })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow('Agent tool audit is uncertain: write_file')
    expect(deps.failToolCall).toHaveBeenCalledWith(19, 41, 'tool-1', 'connection lost', true)
  })

  it('recovers finalizing generic evidence without opening the runtime', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.ensureExecution).mockResolvedValue({
      id: 41, job_id: 19, status: 'running', objective: prompt,
      skill_mode: 'auto', skill_name: null, phase: 'finalizing', version: 3,
      checkpoint: { evidence: {
        kind: 'agent_run', executionId: 41, finalText: '已保存', toolCallCount: 1,
      } },
      audit: {}, completion_evidence: {},
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run', executionId: 41, finalText: '已保存', toolCallCount: 1,
    })
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.completeExecution).toHaveBeenCalledWith(19, 41, expect.objectContaining({
      kind: 'agent_run',
    }))
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('recovers when the finalizing checkpoint was persisted before acknowledgement', async () => {
    const { deps } = dependencies({ text: '已保存' })
    const evidence = {
      kind: 'agent_run' as const, executionId: 41, finalText: '已保存', toolCallCount: 0,
    }
    vi.mocked(deps.ensureExecution)
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'running', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'created', version: 1,
        checkpoint: {}, audit: {}, completion_evidence: {},
      })
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'running', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'finalizing', version: 4,
        checkpoint: { evidence }, audit: {}, completion_evidence: {},
      })
    vi.mocked(deps.checkpointExecution).mockImplementation(async (
      _jobId, _executionId, version, update,
    ) => {
      if (update.phase === 'finalizing') throw new Error('checkpoint acknowledgement lost')
      return {
        id: 41, job_id: 19, status: 'running', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: update.phase, version: version + 1,
        checkpoint: update.checkpoint, audit: update.audit, completion_evidence: {},
      }
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toEqual(evidence)
    expect(deps.openRuntime).toHaveBeenCalledTimes(1)
    expect(deps.completeExecution).toHaveBeenCalledWith(19, 41, evidence)
    expect(deps.failExecution).not.toHaveBeenCalled()
    expect(deps.failStep).not.toHaveBeenCalled()
  })

  it('recovers when execution completion was persisted before acknowledgement', async () => {
    const { deps } = dependencies({ text: '已保存' })
    const evidence = {
      kind: 'agent_run' as const, executionId: 41, finalText: '已保存', toolCallCount: 0,
    }
    vi.mocked(deps.ensureExecution)
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'running', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'created', version: 1,
        checkpoint: {}, audit: {}, completion_evidence: {},
      })
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'succeeded', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'complete', version: 5,
        checkpoint: { evidence }, audit: {}, completion_evidence: evidence,
      })
    vi.mocked(deps.completeExecution).mockRejectedValueOnce(
      new Error('execution completion acknowledgement lost'),
    )

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toEqual(evidence)
    expect(deps.completeExecution).toHaveBeenCalledTimes(1)
    expect(deps.completeStep).toHaveBeenCalledWith(19, 71, evidence)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
    expect(deps.failExecution).not.toHaveBeenCalled()
    expect(deps.failStep).not.toHaveBeenCalled()
  })

  it('recovers when step completion was persisted before acknowledgement', async () => {
    const { deps } = dependencies({ text: '已保存' })
    const evidence = {
      kind: 'agent_run' as const, executionId: 41, finalText: '已保存', toolCallCount: 0,
    }
    vi.mocked(deps.ensureExecution)
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'running', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'created', version: 1,
        checkpoint: {}, audit: {}, completion_evidence: {},
      })
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'succeeded', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'complete', version: 5,
        checkpoint: { evidence }, audit: {}, completion_evidence: evidence,
      })
    vi.mocked(deps.completeStep).mockRejectedValueOnce(
      new Error('step completion acknowledgement lost'),
    )

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toEqual(evidence)
    expect(deps.completeStep).toHaveBeenCalledTimes(2)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
    expect(deps.failExecution).not.toHaveBeenCalled()
    expect(deps.failStep).not.toHaveBeenCalled()
  })

  it('recovers when job completion was persisted before acknowledgement', async () => {
    const { deps } = dependencies({ text: '已保存' })
    const evidence = {
      kind: 'agent_run' as const, executionId: 41, finalText: '已保存', toolCallCount: 0,
    }
    vi.mocked(deps.ensureExecution)
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'running', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'created', version: 1,
        checkpoint: {}, audit: {}, completion_evidence: {},
      })
      .mockResolvedValueOnce({
        id: 41, job_id: 19, status: 'succeeded', objective: prompt,
        skill_mode: 'auto', skill_name: null, phase: 'complete', version: 5,
        checkpoint: { evidence }, audit: {}, completion_evidence: evidence,
      })
    vi.mocked(deps.completeJob)
      .mockRejectedValueOnce(new Error('job completion acknowledgement lost'))
      .mockResolvedValueOnce({})

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toEqual(evidence)
    expect(deps.completeStep).toHaveBeenCalledTimes(2)
    expect(deps.completeJob).toHaveBeenCalledTimes(2)
    expect(deps.failExecution).not.toHaveBeenCalled()
    expect(deps.failStep).not.toHaveBeenCalled()
  })

  it('rejects max-step exhaustion that ends with another tool call', async () => {
    const { deps } = dependencies({
      text: '', finishReason: 'tool-calls', stepCount: 30,
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'scheduled Agent exhausted 30 steps while requesting another tool call',
    )
    expect(deps.completeExecution).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('fails non-retryably after a recorded side effect without final evidence', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([{
      tool_call_id: 'write-before-restart', tool_name: 'write_file',
      status: 'succeeded', side_effecting: true,
    }])

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'scheduled Agent interrupted after side effects; review logs before retry',
    )
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
  })

  it('fails non-retryably after a running side effect without final evidence', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([{
      tool_call_id: 'write-before-crash', tool_name: 'write_file',
      status: 'running', side_effecting: true,
    }])

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'scheduled Agent interrupted after side effects; review logs before retry',
    )
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
  })
})
