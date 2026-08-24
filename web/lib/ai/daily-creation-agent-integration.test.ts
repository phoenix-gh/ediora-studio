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
  digest: 'a'.repeat(64),
  source: 'uploaded',
  enabled: true,
  reviewState: 'approved',
  standardCompatible: true,
  diagnostics: [],
  instructions: 'Read the finance reference and save one X draft.',
  content: 'Read the finance reference and save one X draft.',
  directory: '/fixture/fixture-x-writing',
  packageFiles: [],
  requestedAllowedTools: [],
}

type Executable = {
  execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
}

it('lets a prompt-directed Agent load a Skill and save exactly one X draft', async () => {
  const readReferences: string[] = []
  const completedCalls: Array<{ toolCallId: string; output: unknown }> = []
  const checkpoints: Array<{ phase: string; checkpoint: Record<string, unknown>; audit: Record<string, unknown> }> = []
  let activeSkill = false
  let modelCalls = 0
  let saveDraftCalls = 0
  let recordUsageCalls = 0

  const runtimeDeps: AgentRuntimeDependencies = {
    listEnabledSkills: async () => [fixtureSkill],
    getEnabledSkill: async name => name === fixtureSkill.name ? fixtureSkill : null,
    openTools: async (options: GlobalAgentToolOptions) => {
      const baseTools = {
        loadSkill: tool({
          description: 'Load the one best matching enabled Skill.',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            if (name !== fixtureSkill.name) throw new Error(`Unknown Skill: ${name}`)
            activeSkill = true
            return { name, description: fixtureSkill.description, instructions: fixtureSkill.instructions }
          },
        }),
        readSkillReference: tool({
          description: 'Read a listed Skill reference.',
          inputSchema: z.object({ path: z.string() }),
          execute: async ({ path }) => {
            if (!activeSkill) throw new Error('No Skill is active')
            readReferences.push(path)
            return { path, bytes: 321, content: 'Lead with evidence and a concrete action.' }
          },
        }),
        save_draft: tool({
          description: 'Save one X draft.',
          inputSchema: z.object({
            draft_type: z.literal('x'),
            title: z.string().min(1),
            content: z.string().min(1),
          }),
          execute: async input => {
            const saved = z.object({
              draft_type: z.literal('x'),
              title: z.string().min(1),
              content: z.string().min(1),
            }).parse(input)
            saveDraftCalls += 1
            return {
              id: 101, title: saved.title, status: 'drafting', draft_type: 'x',
            }
          },
        }),
        record_content_usage: tool({
          description: 'Record usage for one persisted output.',
          inputSchema: z.object({
            asset_id: z.number().int().positive(),
            output_kind: z.literal('draft'),
            output_id: z.number().int().positive(),
            topic: z.string(), angle: z.string(), excerpt: z.string(),
            reuse_decision: z.string(),
          }),
          execute: async input => {
            expect(input).toMatchObject({ asset_id: 7, output_id: 101 })
            expect(input).not.toHaveProperty('run_id')
            recordUsageCalls += 1
            return { id: 202 }
          },
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
          source: activeSkill ? 'automatic' as const : undefined,
          activeSkillName: activeSkill ? fixtureSkill.name : undefined,
          referenceCount: activeSkill ? 1 : 0,
          readReferenceCount: readReferences.length,
        }),
        activeContext: () => activeSkill ? {
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
      modelCalls += 1
      const tools = input.tools as Record<string, Executable>
      if (modelCalls === 1) {
        const skill = await tools.loadSkill.execute({ name: fixtureSkill.name }, { toolCallId: 'skill-1' })
        const reference = await tools.readSkillReference.execute({
          path: 'references/finance-writing.md',
        }, { toolCallId: 'reference-1' })
        return {
          text: '素材已经读取，接下来保存草稿。',
          content: [{ type: 'text', text: '素材已经读取，接下来保存草稿。' }],
          finishReason: 'stop', steps: [{}],
          toolCalls: [
            { type: 'tool-call', toolCallId: 'skill-1', toolName: 'loadSkill', input: { name: fixtureSkill.name } },
            { type: 'tool-call', toolCallId: 'reference-1', toolName: 'readSkillReference', input: { path: 'references/finance-writing.md' } },
          ],
          toolResults: [
            { type: 'tool-result', toolName: 'loadSkill', toolCallId: 'skill-1', output: skill },
            { type: 'tool-result', toolName: 'readSkillReference', toolCallId: 'reference-1', output: reference },
          ],
          responseMessages: [{
            role: 'assistant', content: [{ type: 'text', text: '素材已经读取，接下来保存草稿。' }],
          }],
        }
      }
      if (modelCalls === 2) {
        const saved = await tools.save_draft.execute({
        draft_type: 'x', title: 'GitHub 日榜观察', content: '今天值得关注的开源项目。',
        }, { toolCallId: 'save-1' })
        const usage = await tools.record_content_usage.execute({
        asset_id: 7, output_kind: 'draft', output_id: 101,
        topic: 'GitHub 日榜', angle: '今天值得关注', excerpt: '今天值得关注的开源项目。',
        reuse_decision: 'fresh',
        }, { toolCallId: 'usage-1' })
        return {
          text: '一条 X 草稿已保存。',
          content: [{ type: 'text', text: '一条 X 草稿已保存。' }],
          finishReason: 'stop', steps: [{}],
          toolCalls: [
            { type: 'tool-call', toolCallId: 'save-1', toolName: 'save_draft', input: {} },
            { type: 'tool-call', toolCallId: 'usage-1', toolName: 'record_content_usage', input: {} },
          ],
          toolResults: [
            { type: 'tool-result', toolName: 'save_draft', toolCallId: 'save-1', output: saved },
            { type: 'tool-result', toolName: 'record_content_usage', toolCallId: 'usage-1', output: usage },
          ],
          responseMessages: [{
            role: 'assistant', content: [{ type: 'text', text: '一条 X 草稿已保存。' }],
          }],
        }
      }
      const declaration = {
        status: 'completed' as const,
        summary: '一条 X 草稿已保存。',
        evidence: [
          { kind: 'tool_call' as const, id: 'save-1', claim: 'X 草稿已持久化' },
          { kind: 'tool_call' as const, id: 'usage-1', claim: '素材使用记录已持久化' },
        ],
      }
      const completed = await tools.complete_goal.execute(
        declaration,
        { toolCallId: 'goal-1' },
      )
      return {
        text: '', content: [], finishReason: 'tool-calls', steps: [{}],
        toolCalls: [{
          type: 'tool-call', toolCallId: 'goal-1', toolName: 'complete_goal', input: declaration,
        }],
        toolResults: [{
          type: 'tool-result', toolName: 'complete_goal', toolCallId: 'goal-1', output: completed,
        }],
        responseMessages: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate'],
  }

  const execution = {
    id: 41, job_id: 19, status: 'running', objective: 'pending',
    skill_mode: 'auto' as const, skill_name: null, phase: 'prepare',
    checkpoint: {}, audit: {}, completion_evidence: {}, version: 1,
  }
  let runtimeOptions: {
    automaticSelection?: boolean
    skillMode?: string
    dailyCreationRunId?: number
    mode?: string
  } | undefined
  const deps: DailyCreationAgentJobDependencies = {
    getJob: vi.fn().mockResolvedValue({
      id: 19, flow: 'daily_creation', title: 'fixture', status: 'queued',
      input: { run_id: 83 }, steps: [],
    }),
    getContext: vi.fn().mockResolvedValue({
      id: 83, status: 'queued', requested_count: 0,
      rule: {
        name: 'GitHub 日报', prompt: '读取 GitHub 日榜后保存一条 X 草稿。',
        asset_type: 'article', output_type: 'x_short_post', target_count: 0,
        lookback_days: 0, delivery_mode: 'drafts', skill_mode: 'auto',
      },
    }),
    loadModel: vi.fn().mockResolvedValue('fixture-model' as never),
    ensureExecution: vi.fn().mockResolvedValue(execution),
    checkpointExecution: vi.fn().mockImplementation(async (_jobId, _id, version, update) => {
      checkpoints.push(update)
      return { ...execution, version: version + 1, phase: update.phase, checkpoint: update.checkpoint }
    }),
    claimToolCall: vi.fn().mockResolvedValue({ action: 'execute' }),
    listToolCalls: vi.fn().mockResolvedValue([]),
    completeToolCall: vi.fn().mockImplementation(async (_jobId, _id, toolCallId, output) => {
      completedCalls.push({ toolCallId, output })
      return {}
    }),
    failToolCall: vi.fn(),
    failExecution: vi.fn().mockResolvedValue({}),
    completeExecution: vi.fn().mockResolvedValue({}),
    startStep: vi.fn().mockResolvedValue({ id: 71, attempt: 1 }),
    completeStep: vi.fn().mockResolvedValue({}),
    failStep: vi.fn(),
    completeJob: vi.fn().mockResolvedValue({}),
    openRuntime: options => {
      runtimeOptions = options
      return openAgentRuntime({ ...options, dependencies: runtimeDeps })
    },
    apiRoot: () => 'http://api.test',
  }

  const evidence = await runDailyCreationAgentJob(19, deps)

  expect(evidence).toMatchObject({
    kind: 'agent_run', executionId: 41, finalText: '一条 X 草稿已保存。', toolCallCount: 4,
  })
  expect(readReferences).toEqual(['references/finance-writing.md'])
  expect(modelCalls).toBe(3)
  expect(saveDraftCalls).toBe(1)
  expect(recordUsageCalls).toBe(1)
  expect(completedCalls.map(call => call.toolCallId)).toEqual([
    'skill-1', 'reference-1', 'save-1', 'usage-1', 'goal-1',
  ])
  expect(checkpoints.at(-1)?.checkpoint).toEqual(expect.objectContaining({
    evidence: expect.objectContaining({ kind: 'agent_run' }),
  }))
  expect(checkpoints.at(-1)?.audit).toEqual(expect.objectContaining({
    capabilities: expect.objectContaining({ schemaVersion: 1, mode: 'job' }),
  }))
  expect(deps.completeExecution).toHaveBeenCalledWith(19, 41, evidence)
  expect(deps.completeJob).toHaveBeenCalledWith(19)
  expect(runtimeOptions).toMatchObject({
    automaticSelection: false, skillMode: 'auto', dailyCreationRunId: 83, mode: 'job',
  })
  expect(deps.claimToolCall).toHaveBeenCalledWith(19, 41, expect.objectContaining({
    toolName: 'record_content_usage', sideEffecting: true,
  }))
})
