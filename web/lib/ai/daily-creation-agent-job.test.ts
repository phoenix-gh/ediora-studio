import { describe, expect, it, vi } from 'vitest'

import {
  buildDailyCreationAgentObjective,
  firstBlockingToolAudit,
  isNoveltySaveConflict,
  runDailyCreationAgentJob,
  startAgentActivityHeartbeat,
  type DailyCreationAgentContext,
  type DailyCreationAgentJobDependencies,
} from './daily-creation-agent-job'
import type { AgentGoalCompletionDeclaration, AgentToolAudit } from './agent-runtime-types'

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

function savedDraftAudit(id: number): AgentToolAudit {
  return {
    ...audit('save_draft', 'succeeded', true),
    toolCallId: `save-draft-${id}`,
    output: {
      content: [{
        type: 'text',
        text: JSON.stringify({ saved: true, id, title: `草稿 ${id}`, status: 'drafting', draft_type: 'x' }),
      }],
      isError: false,
    },
  }
}

function noveltyConflictAudit(id: number, decision: 'duplicate' | 'uncertain'): AgentToolAudit {
  return {
    ...audit('save_draft', 'succeeded', true),
    toolCallId: `save-conflict-${id}`,
    output: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          saved: false,
          novelty: { decision, suggested_action: 'change_topic' },
        }),
      }],
      isError: false,
    },
  }
}

function savedDraftCall(id: number) {
  const saved = savedDraftAudit(id)
  return {
    tool_call_id: saved.toolCallId,
    tool_name: saved.toolName,
    status: saved.status,
    output: saved.output,
    side_effecting: true,
  }
}

function completedGoalCall(
  summary: string,
  evidenceIds: string[],
) {
  return {
    tool_call_id: 'goal-complete-1',
    tool_name: 'complete_goal',
    status: 'succeeded',
    output: {
      accepted: true,
      declaration: {
        status: 'completed',
        summary,
        evidence: evidenceIds.map(id => ({
          kind: 'tool_call', id, claim: '本次执行已成功持久化',
        })),
      },
    },
    side_effecting: false,
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
  goalCompletion?: AgentGoalCompletionDeclaration | null
}

function dependencies({
  text = '研究完成',
  toolAudits = [savedDraftAudit(3)],
  finishReason = 'stop',
  stepCount = 1,
  goalCompletion,
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
      goalCompletion: goalCompletion === null ? undefined : goalCompletion ?? {
        status: 'completed' as const,
        summary: text.trim() || '既定目标已经完成',
      },
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
    recordJobEvent: vi.fn().mockResolvedValue({}),
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
  it('recognizes structured save conflicts without counting ordinary saves', () => {
    expect(isNoveltySaveConflict(noveltyConflictAudit(1, 'duplicate'))).toBe(true)
    expect(isNoveltySaveConflict(noveltyConflictAudit(2, 'uncertain'))).toBe(true)
    expect(isNoveltySaveConflict(savedDraftAudit(3))).toBe(false)
    expect(isNoveltySaveConflict(audit('check_content_novelty', 'succeeded', false))).toBe(false)
  })

  it('fails non-retryably after three save-time novelty conflicts', async () => {
    const { deps } = dependencies({
      toolAudits: [
        noveltyConflictAudit(1, 'duplicate'),
        noveltyConflictAudit(2, 'uncertain'),
        noveltyConflictAudit(3, 'duplicate'),
      ],
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'no sufficiently novel topic was available in the configured time window',
    )
    expect(deps.completeExecution).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
  })

  it('reports the unresolved failure after a recovered read-only failure', () => {
    const failed = audit('list_creative_asset_candidates', 'failed', false)
    const recovered = audit('list_creative_asset_candidates', 'succeeded', false)
    const unresolved = audit('generateImage', 'failed', true)

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
      audit('generateImage', 'failed', true),
    ] })

    await expect(runDailyCreationAgentJob(19, deps))
      .rejects.toThrow('Agent tool audit is failed: generateImage')
  })

  it('lets a completed goal declaration outrank an unrelated read-only failure', async () => {
    const saved = savedDraftAudit(3)
    const { deps } = dependencies({
      toolAudits: [
        audit('list_creative_asset_candidates', 'failed', false),
        saved,
      ],
      goalCompletion: {
        status: 'completed',
        summary: '草稿已经保存',
      },
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '草稿已经保存',
      toolCallCount: 1,
    })
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('recovers a completed durable goal despite an unrelated read-only failure', async () => {
    const { deps } = dependencies()
    const saved = [savedDraftCall(101), savedDraftCall(102), savedDraftCall(103)]
    vi.mocked(deps.listToolCalls).mockResolvedValue([
      {
        tool_call_id: 'read-1', tool_name: 'list_creative_asset_candidates',
        status: 'failed', error: 'invalid asset type', side_effecting: false,
      },
      ...saved,
      completedGoalCall('既定目标已经完成', ['model-invented-tool-id']),
    ])

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '既定目标已经完成',
      toolCallCount: 3,
    })
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('records Agent tool activity in the Job event stream', async () => {
    const { deps } = dependencies({ toolAudits: [savedDraftAudit(3)] })

    await runDailyCreationAgentJob(19, deps)

    expect(deps.recordJobEvent).toHaveBeenCalledWith(
      19,
      'agent_activity',
      expect.objectContaining({
        activity: 'tool', tool: 'save_draft', status: 'succeeded',
      }),
    )
  })

  it('does not fail the Agent when the Job activity sink is unavailable', async () => {
    const { deps } = dependencies({ toolAudits: [savedDraftAudit(3)] })
    deps.recordJobEvent = vi.fn().mockRejectedValue(new Error('event sink unavailable'))

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '研究完成',
    })
  })

  it('stops the Agent activity heartbeat without leaking timer callbacks', async () => {
    vi.useFakeTimers()
    try {
      const heartbeat = vi.fn().mockResolvedValue(undefined)
      const stop = startAgentActivityHeartbeat(heartbeat, 100)

      await vi.advanceTimersByTimeAsync(250)
      expect(heartbeat).toHaveBeenCalledTimes(2)

      stop()
      await vi.advanceTimersByTimeAsync(250)
      expect(heartbeat).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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
      rule: { prompt },
    })).toBe(prompt)
  })

  it('rejects a blank saved prompt', () => {
    expect(() => buildDailyCreationAgentObjective({
      rule: { prompt: '   ' },
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

  it('completes a daily Agent run after a draft is persisted', async () => {
    const { deps, runtimeRun } = dependencies({
      text: '研究完成', toolAudits: [savedDraftAudit(3)],
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run',
      executionId: 41,
      finalText: '研究完成',
      toolCallCount: 1,
      runtimeEvidence: {
        toolCalls: [{
          toolCallId: 'save-draft-3',
          toolName: 'save_draft',
          status: 'succeeded',
          sideEffecting: true,
        }],
        outputs: [],
      },
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
    expect(runtimeRun.mock.calls[0]?.[0]?.requireGoalCompletion).toBe(true)
    expect(runtimeRun.mock.calls[0]?.[0]?.requiredTools).toBeUndefined()
    expect(runtimeRun.mock.calls[0]?.[0]?.selectedContext).toBeUndefined()
  })

  it('does not succeed after a normal stop without a goal declaration', async () => {
    const { deps } = dependencies({ text: '', goalCompletion: null, toolAudits: [
      audit('loadSkill', 'succeeded', false),
    ] })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'Agent ended without declaring goal completion',
    )
    expect(deps.completeExecution).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), true)
  })

  it('keeps an unresolved read-only failure blocking without a goal declaration', async () => {
    const { deps } = dependencies({
      goalCompletion: null,
      toolAudits: [audit('read_context', 'failed', false)],
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'Agent tool audit is failed: read_context',
    )
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('does not reinterpret prompt or rule counts when the Agent declares completion', async () => {
    const saved = savedDraftAudit(101)
    const { deps, runtimeRun } = dependencies({
      text: '旧的候选文本',
      toolAudits: [saved],
      goalCompletion: {
        status: 'completed', summary: '既定目标已经完成',
      },
    })
    vi.mocked(deps.getContext).mockResolvedValue({
      ...context,
      requested_count: 12,
      rule: {
        ...context.rule, target_count: 12,
        prompt: '创作 3 条中文 X 短帖并保存。',
      },
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run', finalText: '既定目标已经完成', toolCallCount: 1,
    })
    expect(runtimeRun).toHaveBeenCalledWith(expect.objectContaining({
      requireGoalCompletion: true,
    }))
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('fails a blocked declaration and preserves the remaining work', async () => {
    const { deps } = dependencies({
      goalCompletion: {
        status: 'blocked', summary: '缺少发布授权',
        remainingWork: ['等待账号授权'],
      },
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'Agent blocked: 缺少发布授权; remaining work: 等待账号授权',
    )
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('does not reject completion because legacy evidence cites an unavailable tool call', async () => {
    const { deps } = dependencies({
      goalCompletion: {
        status: 'completed', summary: '已完成',
      },
    })
    const runtimeRun = vi.mocked(deps.openRuntime)

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run', finalText: '已完成',
    })
    expect(deps.completeJob).toHaveBeenCalledWith(19)
    expect(runtimeRun).toHaveBeenCalled()
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
      kind: 'agent_run', executionId: 41, finalText: 'x'.repeat(2_000), toolCallCount: 1,
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

  it('does not accept legacy finalizing evidence without a goal declaration', async () => {
    const { deps } = dependencies({ goalCompletion: null })
    vi.mocked(deps.ensureExecution).mockResolvedValue({
      id: 41, job_id: 19, status: 'running', objective: prompt,
      skill_mode: 'auto', skill_name: null, phase: 'finalizing', version: 3,
      checkpoint: { evidence: {
        kind: 'agent_run', executionId: 41, finalText: '已保存', toolCallCount: 1,
      } },
      audit: {}, completion_evidence: {},
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'Agent ended without declaring goal completion',
    )
    expect(deps.openRuntime).toHaveBeenCalledTimes(1)
    expect(deps.completeExecution).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('does not accept legacy completed Step evidence without a goal declaration', async () => {
    const { deps } = dependencies({ goalCompletion: null })
    vi.mocked(deps.getJob).mockResolvedValue({
      id: 19, flow: 'daily_creation', title: 'daily', status: 'queued',
      input: { run_id: 83 },
      steps: [{
        id: 71, key: 'agent', attempt: 1, status: 'succeeded',
        output: {
          kind: 'agent_run', executionId: 41, finalText: '旧完成结果', toolCallCount: 1,
        },
      }],
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'Agent ended without declaring goal completion',
    )
    expect(deps.openRuntime).toHaveBeenCalledTimes(1)
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('recovers an accepted goal declaration from durable tool calls after a worker restart', async () => {
    const { deps } = dependencies()
    const saved = [savedDraftCall(101), savedDraftCall(102), savedDraftCall(103)]
    vi.mocked(deps.listToolCalls).mockResolvedValue([
      ...saved,
      completedGoalCall('既定目标已经完成', saved.map(call => call.tool_call_id)),
    ])

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '既定目标已经完成',
      toolCallCount: 3,
      runtimeEvidence: {
        toolCalls: saved.map(call => expect.objectContaining({
          toolCallId: call.tool_call_id,
          toolName: call.tool_name,
          status: call.status,
          sideEffecting: true,
        })),
      },
    })
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.completeExecution).toHaveBeenCalledWith(
      19, 41, expect.objectContaining({ kind: 'agent_run' }),
    )
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('does not infer completion from a durable side effect without a goal declaration', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([savedDraftCall(101)])

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'scheduled Agent interrupted after side effects; review logs before retry',
    )
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
  })

  it('does not recover drafts across an unresolved durable read failure', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([
      {
        tool_call_id: 'read-1', tool_name: 'get_creative_asset',
        status: 'failed', error: 'asset unavailable', side_effecting: false,
      },
      savedDraftCall(101),
    ])

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'Agent tool audit is failed: get_creative_asset',
    )
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), true)
  })

  it('recovers when the finalizing checkpoint was persisted before acknowledgement', async () => {
    const { deps } = dependencies({ text: '已保存' })
    const evidence = {
      kind: 'agent_run' as const, executionId: 41, finalText: '已保存', toolCallCount: 0,
      goalCompletion: { status: 'completed' as const, summary: '已保存' },
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
      goalCompletion: { status: 'completed' as const, summary: '已保存' },
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
      goalCompletion: { status: 'completed' as const, summary: '已保存' },
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
      goalCompletion: { status: 'completed' as const, summary: '已保存' },
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

  it('accepts an Agent completion declaration at the final execution step', async () => {
    const { deps } = dependencies({
      text: '', finishReason: 'tool-calls', stepCount: 30,
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run', finalText: '既定目标已经完成',
    })
    expect(deps.completeJob).toHaveBeenCalledWith(19)
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

  it('fails non-retryably after an uncertain recorded side effect', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([{
      tool_call_id: 'save-uncertain', tool_name: 'save_draft',
      status: 'uncertain', side_effecting: true,
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
