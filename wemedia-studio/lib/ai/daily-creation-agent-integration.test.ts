import { tool, type ToolSet } from 'ai'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'

import { applyAgentToolPolicy } from './agent-tool-policy'
import {
  openAgentRuntime,
  type AgentRuntimeDependencies,
} from './agent-runtime'
import {
  runDailyCreationAgentJob,
  type DailyCreationAgentJobDependencies,
} from './daily-creation-agent-job'
import type { GlobalAgentToolOptions } from './global-chat-tools'
import type { RegisteredSkill } from '../skills/registry'

const fixtureSkill: RegisteredSkill = {
  name: 'fixture-x-writing',
  description: 'Writes evidence-based Chinese X posts.',
  version: '1.0.0',
  source: 'uploaded',
  enabled: true,
  instructions: 'Read the finance reference, research assets, deduplicate, validate, and save.',
  directory: '/fixture/fixture-x-writing',
}

type Executable = {
  execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
}

it('runs one automatically selected Skill through references, tools, validation, and real save evidence', async () => {
  const readReferences: string[] = []
  const checkpoints: Array<{ phase: string; checkpoint: Record<string, unknown>; audit: Record<string, unknown> }> = []
  const completedCalls: Array<{ toolCallId: string; output: unknown }> = []
  const posts = Array.from({ length: 10 }, (_, index) => ({
    source_asset_ids: [index + 1],
    text: `第 ${index + 1} 条经过校验的短帖`,
    reuse_decision: 'fresh',
    reuse_explanation: '与近期内容不同',
    compared_usage_ids: [],
  }))
  const saveResult = {
    structuredContent: { result: {
      execution_id: 41,
      run_id: 83,
      created_count: 10,
      output_ids: Array.from({ length: 10 }, (_, index) => index + 101),
      usage_ids: Array.from({ length: 10 }, (_, index) => index + 201),
    } },
  }

  const runtimeDeps: AgentRuntimeDependencies = {
    listEnabledSkills: async () => [fixtureSkill],
    getEnabledSkill: async name => name === fixtureSkill.name ? fixtureSkill : null,
    openTools: async (options: GlobalAgentToolOptions) => {
      const baseTools = {
        list_creative_asset_candidates: tool({
          description: 'List candidates.', inputSchema: z.object({}),
          execute: async () => Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })),
        }),
        get_recent_content_usage: tool({
          description: 'List recent usage.', inputSchema: z.object({}),
          execute: async () => [],
        }),
        save_daily_creation_outputs: tool({
          description: 'Atomically save outputs.',
          inputSchema: z.object({ posts: z.array(z.unknown()) }),
          execute: async () => saveResult,
        }),
      } satisfies ToolSet
      const tools = applyAgentToolPolicy(baseTools, {
        policy: options.approvalPolicy ?? 'interactive',
        beforeToolExecute: options.beforeToolExecute,
        onAudit: options.onToolAudit,
      })
      return {
        tools,
        catalogContext: 'fixture catalog',
        snapshot: () => ({
          source: options.skillName ? 'automatic' as const : undefined,
          activeSkillName: options.skillName,
          referenceCount: options.skillName ? 1 : 0,
          readReferenceCount: readReferences.length,
        }),
        activeContext: () => options.skillName ? {
          skill: fixtureSkill,
          references: [{ path: 'references/finance-writing.md', bytes: 321 }],
          activation: 'automatic' as const,
          execution: {
            planRequired: true,
            verificationRequired: true,
            maxRevisions: 1 as const,
          },
        } : undefined,
        readReferences: async (paths: string[]) => {
          readReferences.push(...paths)
          return paths.map(path => ({
            path, bytes: 321, content: 'Lead with evidence and a concrete action.',
          }))
        },
        close: async () => undefined,
      }
    },
    generate: vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Return valid JSON only. Select at most one enabled Skill')) {
        return { output: { skillName: fixtureSkill.name, continueRestored: false } }
      }
      if (prompt.startsWith('Create a bounded execution plan')) {
        return { output: {
          goal: '创作并落库十条短帖',
          steps: [{
            id: 'deliver', instruction: '读取规则、研究、去重、自检并落库',
            requiredReferences: ['references/finance-writing.md'],
            requiredTools: [
              'list_creative_asset_candidates',
              'get_recent_content_usage',
              'save_daily_creation_outputs',
            ],
          }],
          outputRequirements: ['十条中文 X 短帖必须原子落库'],
          verificationCriteria: ['保存工具返回十个真实 output ID'],
        } }
      }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }

      const tools = input.tools as Record<string, Executable>
      const candidates = await tools.list_creative_asset_candidates.execute({}, { toolCallId: 'candidates-1' })
      const usage = await tools.get_recent_content_usage.execute({}, { toolCallId: 'usage-1' })
      const saved = await tools.save_daily_creation_outputs.execute({ posts }, { toolCallId: 'save-1' })
      return {
        text: '十条短帖已校验并落库。',
        content: [],
        toolResults: [
          { toolName: 'list_creative_asset_candidates', toolCallId: 'candidates-1', output: candidates },
          { toolName: 'get_recent_content_usage', toolCallId: 'usage-1', output: usage },
          { toolName: 'save_daily_creation_outputs', toolCallId: 'save-1', output: saved },
        ],
      }
    }) as unknown as AgentRuntimeDependencies['generate'],
  }

  const execution = {
    id: 41, job_id: 19, status: 'running', objective: 'pending',
    skill_mode: 'auto' as const, skill_name: null, phase: 'prepare',
    checkpoint: {}, audit: {}, completion_evidence: {}, version: 1,
  }
  const deps: DailyCreationAgentJobDependencies = {
    getJob: vi.fn().mockResolvedValue({
      id: 19, flow: 'daily_creation', title: 'fixture', status: 'queued',
      input: { run_id: 83 }, steps: [],
    }),
    getContext: vi.fn().mockResolvedValue({
      id: 83, status: 'queued', requested_count: 10,
      rule: {
        name: '搞钱短帖', asset_type: 'article', directory: '搞钱副业',
        directories: ['搞钱副业'], output_type: 'x_short_post', target_count: 10,
        lookback_days: 7, delivery_mode: 'drafts', account_id: null,
        instructions: '', skill_mode: 'auto', skill_name: null,
      },
    }),
    loadModel: vi.fn().mockResolvedValue('fixture-model' as never),
    ensureExecution: vi.fn().mockResolvedValue(execution),
    checkpointExecution: vi.fn().mockImplementation(async (_jobId, _id, version, update) => {
      checkpoints.push(update)
      return { ...execution, version: version + 1, phase: update.phase }
    }),
    claimToolCall: vi.fn().mockResolvedValue({ action: 'execute' }),
    listToolCalls: vi.fn().mockResolvedValue([]),
    completeToolCall: vi.fn().mockImplementation(async (_jobId, _id, toolCallId, output) => {
      completedCalls.push({ toolCallId, output })
      return {}
    }),
    failToolCall: vi.fn(),
    completeExecution: vi.fn().mockResolvedValue({}),
    startStep: vi.fn().mockResolvedValue({ id: 71, attempt: 1 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn(),
    completeJob: vi.fn().mockResolvedValue({}),
    openRuntime: options => openAgentRuntime({ ...options, dependencies: runtimeDeps }),
    apiRoot: () => 'http://api.test',
  }

  const evidence = await runDailyCreationAgentJob(19, deps)

  expect(evidence).toMatchObject({
    toolName: 'save_daily_creation_outputs', toolCallId: 'save-1',
    runId: 83, createdCount: 10,
    outputIds: Array.from({ length: 10 }, (_, index) => index + 101),
  })
  expect(readReferences).toEqual(['references/finance-writing.md'])
  expect(completedCalls.map(call => call.toolCallId)).toEqual([
    'candidates-1', 'usage-1', 'save-1',
  ])
  const finalAudit = checkpoints.at(-1)?.audit as Record<string, unknown>
  expect(finalAudit.skillRun).toMatchObject({
    skillName: 'fixture-x-writing', activation: 'automatic',
    loadedReferences: ['references/finance-writing.md'],
    validation: { passed: true },
  })
  expect(finalAudit.toolCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({
      toolName: 'save_daily_creation_outputs', status: 'succeeded',
      autoApproved: true,
    }),
  ]))
  expect(deps.completeExecution).toHaveBeenCalledWith(19, 41, evidence)
  expect(deps.completeJob).toHaveBeenCalledWith(19)
})
