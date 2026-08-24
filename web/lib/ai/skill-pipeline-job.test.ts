import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  currentPipelineStage,
  runSkillPipelineJob,
  type SkillPipelineJobDependencies,
} from './skill-pipeline-job'
import type { AgentCapabilitySnapshot } from './agent-capabilities'
import type { DurableJob, PipelineStage } from './job-client'

afterEach(() => {
  vi.unstubAllEnvs()
})

function capability(skillName: string): AgentCapabilitySnapshot {
  return {
    schemaVersion: 1,
    mode: 'job',
    skill: {
      name: skillName,
      version: '1.0.0-test',
      source: 'builtin',
      activation: 'manual',
      instructionsDigest: `${skillName}-instructions`,
      references: [],
    },
    tools: [],
    policy: { approvalPolicy: 'automatic', allowedToolNames: [] },
  }
}

function runResult(text: string) {
  return {
    kind: 'completed' as const,
    text,
    parts: [],
    revisionCount: 0 as const,
    finishReason: 'stop',
    stepCount: 1,
    goalCompletion: {
      status: 'completed' as const,
      summary: text,
    },
    skillRun: {
      skillName: 'test',
      activation: 'manual' as const,
      goal: 'test',
      steps: [],
      requiredReferences: [],
      loadedReferences: [],
      requiredTools: [],
      toolEvidence: [],
      outputRequirements: [],
      verificationCriteria: [],
      validation: { passed: true, violations: [] },
    },
  }
}

function pipelineJob(): DurableJob {
  const names = ['source-research', 'writing-plan', 'humanize-writing', 'account-voice']
  const stages: PipelineStage[] = names.map((name, index) => ({
    id: index + 10,
    key: `skill:${String(index + 1).padStart(2, '0')}:${name}`,
    attempt: 1,
    status: 'queued',
    input: {
      objective: 'Write a sourced article',
      plan_stage: {
        position: index + 1,
        step_key: `skill:${String(index + 1).padStart(2, '0')}:${name}`,
        skill_name: name,
        display_name: name,
        expected_output: name === 'source-research' ? 'research_bundle' : 'article',
      },
      invocation: {
        skill_name: name,
        capability_snapshot: capability(name),
        parameter_snapshot: index === 1
          ? { id: 7, title: '深度技术文章', strategy: '证据优先' }
          : index === 3
            ? { id: 'account-a', name: '账号 A', tone: '克制具体' }
            : null,
      },
      parameter_snapshot: index === 1
        ? { id: 7, title: '深度技术文章', strategy: '证据优先' }
        : index === 3
          ? { id: 'account-a', name: '账号 A', tone: '克制具体' }
          : null,
    },
    output: {},
    artifacts: [],
  }))
  return {
    id: 91,
    flow: 'skill_pipeline',
    title: 'Pipeline',
    status: 'queued',
    input: { objective: 'Write a sourced article' },
    steps: [],
    run_epoch: 1,
    pipeline: {
      plan: {
        version: 1,
        objective: 'Write a sourced article',
        stages: stages.map(stage => stage.input.plan_stage),
      },
      stages,
      artifacts: [],
    },
  }
}

function dependencies(job: DurableJob, options: {
  failValidation?: boolean
  missingGoal?: boolean
  blockedGoal?: boolean
  loseCompletionResponse?: boolean
} = {}) {
  const opened: Array<{
    skillName?: string
    selectedContext?: string
    requireGoalCompletion?: boolean
  }> = []
  const failedStages: unknown[] = []
  const failedExecutions: unknown[] = []
  const executions = new Map<number, { id: number; version: number; status: string }>()
  let nextExecutionId = 500
  const deps: SkillPipelineJobDependencies = {
    getJob: vi.fn(async () => job),
    startStage: vi.fn(async (_jobId, stepId) => {
      const stage = job.pipeline?.stages.find(item => item.id === stepId)
      if (stage) {
        stage.status = 'running'
        job.status = 'running'
      }
    }),
    completeStage: vi.fn(async (_jobId, stepId, input) => {
      const stage = job.pipeline?.stages.find(item => item.id === stepId)
      if (stage) {
        stage.status = 'succeeded'
        stage.output = { primary_artifact_id: stepId }
        const artifact = {
          ...input.primary,
          id: stepId + 1000,
          step_id: stepId,
          attempt: input.attempt,
          role: 'primary' as const,
          status: 'active',
        }
        stage.artifacts = [artifact]
        job.pipeline?.artifacts.push(artifact)
        const next = job.pipeline?.stages.find(item => item.id === stepId + 1)
        job.status = next ? 'queued' : 'succeeded'
      }
      if (options.loseCompletionResponse) {
        throw new Error('response lost after durable completion')
      }
      return job
    }),
    failStage: vi.fn(async (_jobId, stepId, input) => {
      failedStages.push({ stepId, input })
      const stage = job.pipeline?.stages.find(item => item.id === stepId)
      if (stage) stage.status = 'failed'
      job.status = 'failed'
      return job
    }),
    loadModel: vi.fn().mockResolvedValue({}),
    ensureExecution: vi.fn(async (_jobId, request) => {
      const existing = executions.get(request.stepId)
      if (existing) return existing as never
      const execution = { id: nextExecutionId++, version: 1, status: 'running' }
      executions.set(request.stepId, execution)
      return execution as never
    }),
    checkpointExecution: vi.fn(async (_jobId, executionId, version) => ({
      id: executionId,
      job_id: job.id,
      step_id: 10,
      attempt: 1,
      status: 'running',
      objective: 'Write a sourced article',
      skill_mode: 'manual' as const,
      skill_name: 'source-research',
      phase: 'execute',
      checkpoint: {},
      audit: {},
      completion_evidence: {},
      version: version + 1,
    })),
    listToolCalls: vi.fn().mockResolvedValue([]),
    claimToolCall: vi.fn().mockResolvedValue({ action: 'execute' as const }),
    completeToolCall: vi.fn().mockResolvedValue({}),
    failToolCall: vi.fn().mockResolvedValue({}),
    failExecution: vi.fn(async (_jobId, executionId, error) => {
      failedExecutions.push({ executionId, error })
    }),
    openRuntime: vi.fn(async optionsForRuntime => {
      opened.push({ skillName: optionsForRuntime.skillName })
      const expected = capability(optionsForRuntime.skillName ?? '')
      return {
        tools: {},
        catalogContext: '',
        selectedSkill: undefined,
        prepare: vi.fn(),
        snapshot: () => ({
          source: 'manual' as const,
          activeSkillName: optionsForRuntime.skillName,
          referenceCount: 0,
          readReferenceCount: 0,
        }),
        activeContext: () => undefined,
        capabilitySnapshot: () => expected,
        readReferences: vi.fn(),
        close: vi.fn(),
        run: vi.fn(async request => {
          opened.at(-1)!.selectedContext = request.selectedContext
          opened.at(-1)!.requireGoalCompletion = request.requireGoalCompletion
          await request.onStep?.({ phase: 'execute', parts: [] })
          const result = options.failValidation
            ? { ...runResult('draft'), skillRun: { ...runResult('draft').skillRun, validation: { passed: false, violations: [] } } }
            : { ...runResult(`${optionsForRuntime.skillName} output`), skillRun: { ...runResult('draft').skillRun, skillName: optionsForRuntime.skillName ?? '' } }
          if (options.missingGoal) return { ...result, goalCompletion: undefined }
          if (options.blockedGoal) return {
            ...result,
            goalCompletion: {
              status: 'blocked' as const,
              summary: '上游资料不足',
              remainingWork: ['补充可信来源'],
            },
          }
          return result
        }),
      }
    }),
    apiRoot: () => 'http://api.test/api',
  }
  vi.stubEnv('WORKER_TOKEN', 'worker-token-at-least-32-characters')
  return { deps, opened, failedStages, failedExecutions }
}

describe('Skill Pipeline production worker', () => {
  it('runs frozen Skills exactly once in plan order and passes the prior artifact forward', async () => {
    const job = pipelineJob()
    const { deps, opened } = dependencies(job)

    for (let index = 0; index < 4; index += 1) {
      await runSkillPipelineJob(job.id, deps)
    }

    expect(opened.map(item => item.skillName)).toEqual([
      'source-research', 'writing-plan', 'humanize-writing', 'account-voice',
    ])
    expect(opened.every(item => item.requireGoalCompletion)).toBe(true)
    expect(opened[1].selectedContext).toContain('source-research output')
    expect(opened[1].selectedContext).toContain('深度技术文章')
    expect(opened[3].selectedContext).toContain('账号 A')
    expect(job.status).toBe('succeeded')
    expect(deps.completeStage).toHaveBeenCalledTimes(4)
    expect(vi.mocked(deps.ensureExecution).mock.calls.map(call => call[1].stepId)).toEqual([10, 11, 12, 13])
    expect(job.pipeline?.artifacts.map(artifact => artifact.kind)).toEqual([
      'research_bundle', 'article', 'article', 'article',
    ])
    expect(JSON.stringify(job.pipeline)).not.toMatch(/api[_-]?key|access[_-]?token|app[_-]?secret/i)
    expect(deps.failStage).not.toHaveBeenCalled()
  })

  it('treats Skill validation as advisory when the Agent declares completion', async () => {
    const job = pipelineJob()
    const { deps, failedStages, failedExecutions } = dependencies(job, { failValidation: true })

    await expect(runSkillPipelineJob(job.id, deps)).resolves.toMatchObject({
      kind: 'agent_run', finalText: 'draft',
    })

    expect(failedExecutions).toHaveLength(0)
    expect(failedStages).toHaveLength(0)
    expect(job.pipeline?.stages[0].status).toBe('succeeded')
  })

  it('does not persist a Stage after an ordinary stop without a goal declaration', async () => {
    const job = pipelineJob()
    const { deps, failedStages } = dependencies(job, { missingGoal: true })

    await expect(runSkillPipelineJob(job.id, deps)).rejects.toThrow(
      'Agent ended without declaring goal completion',
    )
    expect(deps.completeStage).not.toHaveBeenCalled()
    expect(failedStages).toHaveLength(1)
  })

  it('does not start the next Stage after the Agent declares the current Stage blocked', async () => {
    const job = pipelineJob()
    const { deps, opened } = dependencies(job, { blockedGoal: true })

    await expect(runSkillPipelineJob(job.id, deps)).rejects.toThrow(
      'Agent blocked: 上游资料不足; remaining work: 补充可信来源',
    )
    expect(opened).toHaveLength(1)
    expect(job.pipeline?.stages[1].status).toBe('queued')
  })

  it('recovers when the durable completion succeeded but the response was lost', async () => {
    const job = pipelineJob()
    const { deps, failedStages } = dependencies(job, { loseCompletionResponse: true })

    const evidence = await runSkillPipelineJob(job.id, deps)

    expect(evidence).toMatchObject({ kind: 'agent_run' })
    expect(job.pipeline?.stages[0].status).toBe('succeeded')
    expect(failedStages).toHaveLength(0)
  })

  it('does not accept a succeeded execution with legacy completion evidence', async () => {
    const job = pipelineJob()
    const stage = job.pipeline!.stages[0]
    const primary = {
      id: 1010,
      step_id: stage.id,
      attempt: stage.attempt,
      role: 'primary' as const,
      status: 'active' as const,
      kind: 'research_bundle',
      title: 'source-research',
      text_content: '旧的研究产物',
    }
    stage.status = 'running'
    stage.artifacts = [primary]
    job.pipeline!.artifacts = [primary]
    job.status = 'running'
    const { deps, failedStages } = dependencies(job)
    vi.mocked(deps.ensureExecution).mockResolvedValue({
      id: 500,
      job_id: job.id,
      step_id: stage.id,
      attempt: stage.attempt,
      status: 'succeeded',
      objective: 'Write a sourced article',
      skill_mode: 'manual',
      skill_name: 'source-research',
      phase: 'complete',
      checkpoint: {},
      audit: {},
      completion_evidence: {
        kind: 'agent_run', executionId: 500, finalText: '旧完成结果', toolCallCount: 1,
      },
      version: 3,
    })

    await expect(runSkillPipelineJob(job.id, deps)).rejects.toThrow(
      'Agent execution completion evidence has no valid goal declaration',
    )
    expect(deps.completeStage).not.toHaveBeenCalled()
    expect(failedStages).toHaveLength(1)
  })

  it('selects only the first queued or running Stage', () => {
    const job = pipelineJob()
    expect(currentPipelineStage(job)?.key).toBe('skill:01:source-research')
    job.pipeline!.stages[0].status = 'succeeded'
    expect(currentPipelineStage(job)?.key).toBe('skill:02:writing-plan')
  })

  it('does not invoke a terminal or awaiting-confirmation Job', async () => {
    for (const status of ['succeeded', 'cancelled', 'awaiting_confirmation']) {
      const job = pipelineJob()
      job.status = status
      const { deps } = dependencies(job)

      await runSkillPipelineJob(job.id, deps)

      expect(deps.startStage).not.toHaveBeenCalled()
      expect(deps.ensureExecution).not.toHaveBeenCalled()
    }
  })
})
