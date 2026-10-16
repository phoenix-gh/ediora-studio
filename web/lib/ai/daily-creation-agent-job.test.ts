import { describe, expect, it, vi } from 'vitest'

import {
  createScriptedCodexPeer,
  requestByMethod,
  sentMethods,
  type ScriptedCodexPeerOptions,
} from '../../test/codex-jsonl-peer'
import { CODEX_THREAD_CWD, DEFAULT_CODEX_MODEL } from './codex-app-server'
import { codexThreadModel } from './codex-model'
import { runCodexAgentTurn } from './codex-app-server-client'
import { scheduledEdioraMcpServers } from './ediora-mcp'
import {
  buildDailyCreationAgentObjective,
  firstBlockingToolAudit,
  isNoveltySaveConflict,
  jobTimelineActivity,
  runDailyCreationAgentJob,
  startAgentActivityHeartbeat,
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

function noveltyConflictCall(id: number, decision: 'duplicate' | 'uncertain') {
  const conflict = noveltyConflictAudit(id, decision)
  return {
    tool_call_id: conflict.toolCallId,
    tool_name: conflict.toolName,
    status: conflict.status,
    output: { structuredContent: { result: JSON.parse(
      String((conflict.output as { content: Array<{ text: string }> }).content[0].text),
    ) } },
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

type DependencyOptions = {
  text?: string
  peer?: ScriptedCodexPeerOptions
}

function dependencies({
  text = '研究完成',
  peer,
}: DependencyOptions = {}) {
  const execution = {
    id: 41, job_id: 19, status: 'running', objective: prompt,
    skill_mode: 'auto' as const, skill_name: null, phase: 'created',
    checkpoint: {}, audit: {}, completion_evidence: {}, version: 1,
  }
  let lastPeer: ReturnType<typeof createScriptedCodexPeer> | undefined
  const runAgentTurn = vi.fn(async (
    options: Parameters<DailyCreationAgentJobDependencies['runAgentTurn']>[0],
  ) => {
    lastPeer = createScriptedCodexPeer({ agentText: text, ...peer })
    return runCodexAgentTurn({ ...options, transport: lastPeer.transport })
  })
  const deps: DailyCreationAgentJobDependencies = {
    getJob: vi.fn().mockResolvedValue({
      id: 19, flow: 'daily_creation', title: 'daily', status: 'queued',
      input: { run_id: 83 }, steps: [],
    }),
    getContext: vi.fn().mockResolvedValue(context),
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
    runAgentTurn,
  }
  return { deps, runAgentTurn, get lastPeer() { return lastPeer } }
}

describe('daily creation Agent job', () => {
  it('recognizes structured save conflicts without counting ordinary saves', () => {
    expect(isNoveltySaveConflict(noveltyConflictAudit(1, 'duplicate'))).toBe(true)
    expect(isNoveltySaveConflict(noveltyConflictAudit(2, 'uncertain'))).toBe(true)
    expect(isNoveltySaveConflict(savedDraftAudit(3))).toBe(false)
    expect(isNoveltySaveConflict(audit('check_content_novelty', 'succeeded', false))).toBe(false)
  })

  it('resumes after a persisted save conflict because no draft was written', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([
      noveltyConflictCall(1, 'duplicate'),
    ])

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '研究完成',
    })
    expect(deps.runAgentTurn).toHaveBeenCalledTimes(1)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('counts persisted save conflicts toward the three-conflict limit', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([
      noveltyConflictCall(1, 'duplicate'),
      noveltyConflictCall(2, 'uncertain'),
      noveltyConflictCall(3, 'duplicate'),
    ])

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'no sufficiently novel topic was available in the configured time window',
    )
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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

  it('lets Codex completion outrank an unrelated persisted read-only failure after a recorded goal', async () => {
    const { deps } = dependencies({ text: '草稿已经保存' })
    vi.mocked(deps.listToolCalls).mockResolvedValue([
      {
        tool_call_id: 'read-1', tool_name: 'list_creative_asset_candidates',
        status: 'failed', error: 'invalid asset type', side_effecting: false,
      },
      savedDraftCall(3),
      completedGoalCall('草稿已经保存', ['save-draft-3']),
    ])

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '草稿已经保存',
    })
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('records Codex tool failures in the session log', async () => {
    const { deps } = dependencies({
      peer: {
        completedItems: [{
          type: 'McpToolCall',
          id: 'call-1',
          server: 'ediora',
          tool: 'generateImage',
          arguments: { prompt: 'red apple' },
          status: 'failed',
          error: { message: 'MCP tool call requires approval, but approval policy is never' },
        }],
      },
    })
    const sessionEvents: Array<Record<string, unknown>> = []
    deps.appendSessionEvent = vi.fn(async (_jobId, _executionId, event) => {
      sessionEvents.push(event as Record<string, unknown>)
    })

    await runDailyCreationAgentJob(19, deps)

    const result = sessionEvents.find(event => event.type === 'tool/result')
    expect(result?.data).toMatchObject({
      callId: 'call-1',
      isError: true,
      error: 'MCP tool call requires approval, but approval policy is never',
    })
    expect(sessionEvents.map(event => event.type).indexOf('tool/call')).toBeLessThan(
      sessionEvents.map(event => event.type).indexOf('turn/end'),
    )
  })

  it('records Codex turn boundaries without token deltas', async () => {
    const { deps } = dependencies()

    await runDailyCreationAgentJob(19, deps)

    expect(deps.recordJobEvent).toHaveBeenCalledWith(
      19,
      'agent_activity',
      expect.objectContaining({
        activity: 'codex', method: 'turn/completed',
      }),
    )
    const activities = vi.mocked(deps.recordJobEvent).mock.calls.map(call => call[2])
    expect(activities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'item/agentMessage/delta' }),
    ]))
    expect(activities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ activity: 'model' }),
    ]))
    expect(activities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ activity: 'heartbeat' }),
    ]))
  })

  it('keeps reasoning tokens out of the job timeline and keeps tool results', () => {
    expect(jobTimelineActivity({ method: 'item/reasoning/textDelta', params: { delta: 'a' } })).toBeNull()
    expect(jobTimelineActivity({ method: 'item/agentMessage/delta', params: { delta: 'a' } })).toBeNull()
    expect(jobTimelineActivity({ method: 'thread/tokenUsage/updated' })).toBeNull()
    expect(jobTimelineActivity({ method: 'turn/completed' })).toEqual({
      activity: 'codex',
      payload: { method: 'turn/completed' },
    })
    expect(jobTimelineActivity({
      method: 'item/completed',
      params: {
        item: { type: 'Reasoning' },
      },
    })).toBeNull()
    expect(jobTimelineActivity({
      method: 'item/completed',
      params: {
        item: {
          type: 'McpToolCall',
          server: 'ediora',
          tool: 'generateImage',
          status: 'failed',
        },
      },
    })).toEqual({
      activity: 'tool',
      payload: {
        method: 'item/completed',
        itemType: 'McpToolCall',
        server: 'ediora',
        tool: 'generateImage',
        status: 'failed',
      },
    })
  })

  it('does not fail the Agent when the Job activity sink is unavailable', async () => {
    const { deps } = dependencies()
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
    const { deps, runAgentTurn } = dependencies()
    const sessionEvents: Array<Record<string, unknown>> = []
    runAgentTurn.mockRejectedValue(new Error('LLM 接口失败'))
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
      'turn/start', 'user/message', 'agent/skill', 'assistant/message', 'turn/end',
    ])
    expect(sessionEvents.find(event => event.type === 'assistant/message')?.data).toMatchObject({
      blocks: [{ kind: 'text', text: '研究完成' }],
    })
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
  })

  it('completes a daily Agent run through Codex app-server', async () => {
    const harness = dependencies({ text: '研究完成' })

    await expect(runDailyCreationAgentJob(19, harness.deps)).resolves.toMatchObject({
      kind: 'agent_run',
      executionId: 41,
      finalText: '研究完成',
      goalCompletion: { status: 'completed', summary: '研究完成' },
    })
    expect(harness.deps.completeJob).toHaveBeenCalledWith(19)
    const mcpServers = scheduledEdioraMcpServers(83)
    expect(mcpServers.ediora.http_headers).toEqual({
      'X-Agent-Mode': 'scheduled',
      'X-Daily-Creation-Run-Id': '83',
    })
    expect(harness.deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: prompt,
      approvalPolicy: 'never',
      mcpServers,
    }))
    expect(harness.deps.runAgentTurn).toHaveBeenCalledWith(expect.not.objectContaining({
      model: expect.anything(),
    }))
    expect(sentMethods(harness.lastPeer!).slice(0, 4)).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ])
    const threadModel = codexThreadModel(DEFAULT_CODEX_MODEL)
    expect(requestByMethod(harness.lastPeer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      modelProvider: threadModel.modelProvider,
      cwd: CODEX_THREAD_CWD,
      permissions: 'ediora-workspace',
      config: expect.objectContaining({ mcp_servers: mcpServers, permissions: expect.any(Object) }),
    }))
    expect(requestByMethod(harness.lastPeer!, 'turn/start')?.params).not.toHaveProperty('config')
    expect(requestByMethod(harness.lastPeer!, 'turn/start')?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      input: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: prompt }),
      ]),
    }))
    expect(harness.deps.checkpointExecution).toHaveBeenCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'prepared',
      }),
    )
    expect(harness.deps.checkpointExecution).toHaveBeenLastCalledWith(
      19, 41, expect.any(Number), expect.objectContaining({
        phase: 'finalizing',
      }),
    )
  })

  it('passes the configured Codex model into the turn', async () => {
    const harness = dependencies({ text: '研究完成' })
    harness.deps.codexTurn = async () => ({
      model: 'proxy/settings-model',
      reasoningEffort: 'high',
    })

    await runDailyCreationAgentJob(19, harness.deps)

    expect(harness.deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'proxy/settings-model',
      reasoningEffort: 'high',
      approvalPolicy: 'never',
    }))
    const threadModel = codexThreadModel('proxy/settings-model')
    expect(requestByMethod(harness.lastPeer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      modelProvider: threadModel.modelProvider,
    }))
    expect(requestByMethod(harness.lastPeer!, 'turn/start')?.params).toEqual(expect.objectContaining({
      effort: 'high',
    }))
  })

  it('uses the task Codex model and effort instead of system settings', async () => {
    const harness = dependencies({ text: '研究完成' })
    harness.deps.codexTurn = vi.fn(async () => ({
      model: 'proxy/settings-model',
      reasoningEffort: 'high',
    }))
    vi.mocked(harness.deps.getContext).mockResolvedValue({
      ...context,
      rule: {
        ...context.rule,
        codex_model: 'proxy/task-model',
        codex_reasoning_effort: 'low',
      },
    })

    await runDailyCreationAgentJob(19, harness.deps)

    expect(harness.deps.codexTurn).not.toHaveBeenCalled()
    expect(harness.deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'proxy/task-model',
      reasoningEffort: 'low',
    }))
    const threadModel = codexThreadModel('proxy/task-model')
    expect(requestByMethod(harness.lastPeer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: threadModel.model,
      modelProvider: threadModel.modelProvider,
    }))
    expect(requestByMethod(harness.lastPeer!, 'turn/start')?.params).toEqual(expect.objectContaining({
      effort: 'low',
    }))
  })

  it('keeps the system effort when the task only sets a model', async () => {
    const harness = dependencies({ text: '研究完成' })
    harness.deps.codexTurn = vi.fn(async () => ({
      model: 'proxy/settings-model',
      reasoningEffort: 'high',
    }))
    vi.mocked(harness.deps.getContext).mockResolvedValue({
      ...context,
      rule: {
        ...context.rule,
        codex_model: 'gpt-task',
        codex_reasoning_effort: ' ',
      },
    })

    await runDailyCreationAgentJob(19, harness.deps)

    expect(harness.deps.codexTurn).toHaveBeenCalled()
    expect(harness.deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-task',
      reasoningEffort: 'high',
    }))
    expect(requestByMethod(harness.lastPeer!, 'thread/start')?.params).toEqual(expect.objectContaining({
      model: 'gpt-task',
    }))
    expect(requestByMethod(harness.lastPeer!, 'thread/start')?.params).not.toHaveProperty('modelProvider')
  })

  it('ignores an unusable task model and uses system settings', async () => {
    const harness = dependencies({ text: '研究完成' })
    harness.deps.codexTurn = vi.fn(async () => ({
      model: 'proxy/settings-model',
      reasoningEffort: 'high',
    }))
    vi.mocked(harness.deps.getContext).mockResolvedValue({
      ...context,
      rule: {
        ...context.rule,
        codex_model: 'proxy/deepseek-flash',
        codex_reasoning_effort: 'not an effort',
      },
    })

    await runDailyCreationAgentJob(19, harness.deps)

    expect(harness.deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      model: 'proxy/settings-model',
      reasoningEffort: 'high',
    }))
  })

  it('resumes the stored job thread on a later turn', async () => {
    const harness = dependencies({ text: '研究完成' })
    vi.mocked(harness.deps.getJob).mockResolvedValue({
      id: 19,
      flow: 'daily_creation',
      title: 'daily',
      status: 'queued',
      codex_thread_id: 'thr_existing',
      input: { run_id: 83 },
      steps: [],
    })

    await runDailyCreationAgentJob(19, harness.deps)

    expect(sentMethods(harness.lastPeer!).slice(0, 4)).toEqual([
      'initialize', 'initialized', 'thread/resume', 'turn/start',
    ])
    expect(requestByMethod(harness.lastPeer!, 'thread/resume')?.params).toEqual(expect.objectContaining({
      threadId: 'thr_existing',
    }))
  })

  it('fails the Job when Codex reports turn/failed', async () => {
    const { deps } = dependencies({
      text: '',
      peer: { terminal: 'failed', terminalMethod: 'turn/failed' },
    })

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(/failed/i)
    expect(deps.completeExecution).not.toHaveBeenCalled()
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('does not reinterpret prompt or rule counts when Codex completes', async () => {
    const { deps } = dependencies({ text: '既定目标已经完成' })
    vi.mocked(deps.getContext).mockResolvedValue({
      ...context,
      requested_count: 12,
      rule: {
        ...context.rule, target_count: 12,
        prompt: '创作 3 条中文 X 短帖并保存。',
      },
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      kind: 'agent_run', finalText: '既定目标已经完成',
    })
    expect(deps.runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: '创作 3 条中文 X 短帖并保存。',
    }))
    expect(deps.completeJob).toHaveBeenCalledWith(19)
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

  it('ignores legacy finalizing evidence without a goal declaration and runs Codex', async () => {
    const { deps } = dependencies({ text: '研究完成' })
    vi.mocked(deps.ensureExecution).mockResolvedValue({
      id: 41, job_id: 19, status: 'running', objective: prompt,
      skill_mode: 'auto', skill_name: null, phase: 'finalizing', version: 3,
      checkpoint: { evidence: {
        kind: 'agent_run', executionId: 41, finalText: '已保存', toolCallCount: 1,
      } },
      audit: {}, completion_evidence: {},
    })

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '研究完成',
    })
    expect(deps.runAgentTurn).toHaveBeenCalledTimes(1)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('ignores legacy completed Step evidence without a goal declaration and runs Codex', async () => {
    const { deps } = dependencies({ text: '研究完成' })
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

    await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
      finalText: '研究完成',
    })
    expect(deps.runAgentTurn).toHaveBeenCalledTimes(1)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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
    expect(deps.runAgentTurn).toHaveBeenCalledTimes(1)
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
      text: '',
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
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
    expect(deps.runAgentTurn).not.toHaveBeenCalled()
    expect(deps.failStep).toHaveBeenCalledWith(19, 71, expect.any(Error), false)
  })
})
