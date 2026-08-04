import { describe, expect, it, vi } from 'vitest'

import {
  buildDailyCreationAgentObjective,
  runDailyCreationAgentJob,
  type DailyCreationAgentContext,
  type DailyCreationAgentJobDependencies,
} from './daily-creation-agent-job'
import type { AgentToolAudit } from './agent-runtime-types'

const context: DailyCreationAgentContext = {
  id: 83,
  status: 'queued',
  requested_count: 10,
  rule: {
    name: '每日搞钱短帖', asset_type: 'article', directory: '搞钱副业',
    directories: ['搞钱副业'], output_type: 'x_short_post', target_count: 10,
    lookback_days: 7, delivery_mode: 'drafts', account_id: null,
    instructions: '保持具体、克制。', skill_mode: 'auto', skill_name: null,
  },
}

function dependencies(toolOutput?: unknown): DailyCreationAgentJobDependencies {
  const execution = {
    id: 41, job_id: 19, status: 'running', objective: 'pending',
    skill_mode: 'auto' as const, skill_name: null, phase: 'created',
    checkpoint: {}, audit: {}, completion_evidence: {}, version: 1,
  }
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
    completeExecution: vi.fn().mockResolvedValue({}),
    startStep: vi.fn().mockResolvedValue({ id: 71, attempt: 1 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn().mockResolvedValue({}),
    completeJob: vi.fn().mockResolvedValue({}),
    apiRoot: () => 'http://api.test',
    openRuntime: vi.fn().mockImplementation(async options => ({
      tools: {}, catalogContext: '', selectedSkill: undefined,
      prepare: vi.fn(), snapshot: () => ({ referenceCount: 0, readReferenceCount: 0 }),
      activeContext: () => undefined, readReferences: vi.fn(), close: vi.fn(),
      run: vi.fn().mockImplementation(async request => {
        await request.onStep?.({ phase: 'execute', parts: [{ type: 'text', text: 'done' }] })
        if (toolOutput !== undefined) {
          const started: AgentToolAudit = {
            toolName: 'save_daily_creation_outputs', toolCallId: 'save-1',
            sideEffecting: true, autoApproved: true, status: 'started',
            inputSummary: { run_id: 83 }, occurredAt: '2026-08-04T00:00:00Z',
          }
          await options.beforeToolExecute?.(started)
          await options.onToolAudit?.({ ...started, status: 'succeeded', output: toolOutput })
        }
        return { kind: 'completed', text: '已完成', parts: [], revisionCount: 0 }
      }),
    })),
  }
  return deps
}

describe('daily creation Agent job', () => {
  it('gives one Agent the full task and persistence evidence contract', () => {
    const objective = buildDailyCreationAgentObjective({ ...context, executionId: 41 })
    expect(objective).toContain('搞钱副业')
    expect(objective).toContain('10 条中文 X 短帖')
    expect(objective).toContain('最近 7 天')
    expect(objective).toContain('save_daily_creation_outputs')
    expect(objective).toContain('只有该工具返回的真实 ID 才表示完成')
    expect(objective).not.toContain('select → generate → validate')
  })

  it('fails prose-only output because it has no persistence evidence', async () => {
    const deps = dependencies()

    await expect(runDailyCreationAgentJob(19, deps)).rejects.toThrow(
      'missing valid save_daily_creation_outputs evidence',
    )
    expect(deps.failStep).toHaveBeenCalledWith(
      19, 71, expect.any(Error), false,
    )
    expect(deps.completeJob).not.toHaveBeenCalled()
  })

  it('completes only from the final save tool real IDs', async () => {
    const deps = dependencies({
      structuredContent: { result: {
        execution_id: 41, run_id: 83, created_count: 10,
        output_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        usage_ids: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
      } },
    })

    const evidence = await runDailyCreationAgentJob(19, deps)

    expect(evidence).toMatchObject({
      toolName: 'save_daily_creation_outputs', toolCallId: 'save-1',
      runId: 83, createdCount: 10,
    })
    expect(deps.completeExecution).toHaveBeenCalledWith(19, 41, evidence)
    expect(deps.completeStep).toHaveBeenCalledWith(19, 71, evidence)
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('recovers persisted save evidence without rerunning the model', async () => {
    const deps = dependencies()
    vi.mocked(deps.listToolCalls).mockResolvedValue([{
      tool_call_id: 'save-before-restart',
      tool_name: 'save_daily_creation_outputs', status: 'succeeded',
      output: {
        structuredContent: { result: {
          execution_id: 41, run_id: 83, created_count: 1,
          output_ids: [91], usage_ids: [191],
        } },
      },
    }])

    const evidence = await runDailyCreationAgentJob(19, deps)

    expect(evidence).toMatchObject({
      toolCallId: 'save-before-restart', createdCount: 1, outputIds: [91],
    })
    expect(deps.openRuntime).not.toHaveBeenCalled()
    expect(deps.completeJob).toHaveBeenCalledWith(19)
  })

  it('resumes the existing running Agent step after startup reconciliation', async () => {
    const deps = dependencies()
    vi.mocked(deps.getJob).mockResolvedValue({
      id: 19, flow: 'daily_creation', title: 'daily', status: 'running',
      input: { run_id: 83 },
      steps: [{
        id: 75, key: 'agent', attempt: 1, status: 'running', output: {},
      }],
    })
    vi.mocked(deps.listToolCalls).mockResolvedValue([{
      tool_call_id: 'saved', tool_name: 'save_daily_creation_outputs',
      status: 'succeeded', output: { structuredContent: { result: {
        execution_id: 41, run_id: 83, created_count: 1,
        output_ids: [92], usage_ids: [192],
      } } },
    }])

    await runDailyCreationAgentJob(19, deps)

    expect(deps.startStep).not.toHaveBeenCalled()
    expect(deps.completeStep).toHaveBeenCalledWith(
      19, 75, expect.objectContaining({ outputIds: [92] }),
    )
  })
})
