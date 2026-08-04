import { tool, type ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { applyAgentToolPolicy } from './agent-tool-policy'
import { agentSkillRunAudit, openAgentRuntime, type AgentRuntimeDependencies } from './agent-runtime'
import type { GlobalAgentToolOptions } from './global-chat-tools'
import type { RegisteredSkill } from '../skills/registry'

const alpha: RegisteredSkill = {
  name: 'Alpha', description: 'Handles alpha work', version: '1.0.0', source: 'uploaded',
  enabled: true, instructions: '# Alpha workflow', directory: '/skills/alpha',
}

function dependencies(selection: { skillName?: string; continueRestored?: boolean } = {}): AgentRuntimeDependencies {
  return {
    listEnabledSkills: async () => [alpha],
    getEnabledSkill: async name => name === alpha.name ? alpha : null,
    generate: vi.fn(async () => ({
      output: { continueRestored: false, ...selection },
      text: '', toolResults: [], content: [],
    })) as unknown as AgentRuntimeDependencies['generate'],
    openTools: async (options: GlobalAgentToolOptions) => {
      const base = {
        search_assets: tool({ inputSchema: z.object({}), execute: async () => [] }),
        save_draft: tool({ inputSchema: z.object({}), execute: async () => ({ id: 3 }) }),
      } satisfies ToolSet
      const tools = applyAgentToolPolicy(base, { policy: options.approvalPolicy ?? 'interactive' })
      return {
        tools,
        catalogContext: 'Enabled Skills available for automatic activation:\n- Alpha: Handles alpha work',
        snapshot: () => ({
          source: options.skillName ? 'manual' as const : undefined,
          activeSkillName: options.skillName,
          referenceCount: 0,
          readReferenceCount: 0,
        }),
        activeContext: () => options.skillName ? {
          skill: alpha,
          references: [],
          activation: 'manual' as const,
          execution: { planRequired: true, verificationRequired: true, maxRevisions: 1 as const },
        } : undefined,
        readReferences: async () => [],
        close: async () => undefined,
      }
    },
  }
}

function openOptions(
  approvalPolicy: 'interactive' | 'automatic',
  deps: AgentRuntimeDependencies,
) {
  return {
    apiBase: 'http://localhost:8000/api',
    model: 'fake-model' as never,
    approvalPolicy,
    skillMode: 'auto' as const,
    dependencies: deps,
  }
}

describe('shared Agent runtime', () => {
  it('exposes the same global tool names to interactive and automatic adapters', async () => {
    const deps = dependencies()
    const chat = await openAgentRuntime(openOptions('interactive', deps))
    const background = await openAgentRuntime(openOptions('automatic', deps))

    expect(Object.keys(background.tools).sort()).toEqual(['save_draft', 'search_assets'])
    expect(Object.keys(background.tools).sort()).toEqual(Object.keys(chat.tools).sort())
    await chat.close()
    await background.close()
  })

  it('fails before model execution when a manually selected Skill is unavailable', async () => {
    const deps = dependencies()

    await expect(openAgentRuntime({
      ...openOptions('automatic', deps),
      skillMode: 'manual',
      skillName: 'Disabled',
    })).rejects.toThrow('Selected skill is unavailable')
    expect(deps.generate).not.toHaveBeenCalled()
  })

  it('automatically selects one enabled Skill from the task objective', async () => {
    const runtime = await openAgentRuntime(openOptions(
      'automatic', dependencies({ skillName: 'Alpha' }),
    ))

    await expect(runtime.prepare('Do the alpha task')).resolves.toMatchObject({
      skill: { name: 'Alpha' }, activation: 'automatic',
    })
    expect(runtime.selectedSkill).toMatchObject({ skill: { name: 'Alpha' } })
    await runtime.close()
  })

  it('continues without a Skill when automatic selection has no clear match', async () => {
    const runtime = await openAgentRuntime(openOptions('automatic', dependencies()))

    await expect(runtime.prepare('A plain unrelated question')).resolves.toBeUndefined()
    expect(runtime.selectedSkill).toBeUndefined()
    expect(Object.keys(runtime.tools).sort()).toEqual(['save_draft', 'search_assets'])
    await runtime.close()
  })

  it('runs an activated Skill through plan, execution, validation, and shared audit', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) {
        return {
          output: {
            goal: '完成 Alpha 任务',
            steps: [{
              id: 'deliver', instruction: '检索并交付', requiredReferences: [],
              requiredTools: ['search_assets'],
            }],
            outputRequirements: ['基于工具证据'],
            verificationCriteria: ['确认检索已完成'],
          },
        }
      }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }
      return {
        text: 'validated output',
        toolResults: [{
          toolName: 'search_assets', toolCallId: 'call-search', output: [{ id: 11 }],
        }],
        content: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      skillMode: 'manual',
      skillName: 'Alpha',
    })
    const phases: string[] = []

    const result = await runtime.run({
      objective: 'Do the alpha task',
      modelMessages: [],
      selectedContext: '',
      maxSteps: 5,
      onStep: checkpoint => { phases.push(checkpoint.phase) },
    })

    expect(result).toMatchObject({
      kind: 'completed', text: 'validated output', revisionCount: 0,
      selectedSkill: { name: 'Alpha', activation: 'manual' },
      skillRun: { skillName: 'Alpha', validation: { passed: true } },
    })
    expect(phases).toEqual(['plan', 'execute', 'validate'])
    expect(agentSkillRunAudit(result)).toMatchObject({
      skillName: 'Alpha', activation: 'manual', revisionCount: 0,
      toolEvidence: [{ toolName: 'search_assets', state: 'succeeded' }],
    })
    await runtime.close()
  })

  it('keeps adapter-required tools active even when the Skill plan omits one', async () => {
    const deps = dependencies()
    let activeTools: unknown
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) {
        return {
          output: {
            goal: '完成任务',
            steps: [{
              id: 'research', instruction: '检索', requiredReferences: [],
              requiredTools: ['search_assets'],
            }],
            outputRequirements: [], verificationCriteria: [],
          },
        }
      }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }
      activeTools = input.activeTools
      return { text: 'done', toolResults: [], content: [] }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), skillMode: 'manual', skillName: 'Alpha',
    })

    await runtime.run({
      objective: 'Do the alpha task', modelMessages: [], maxSteps: 5,
      requiredTools: ['save_draft'],
    })

    expect(activeTools).toEqual(['search_assets', 'save_draft'])
  })

  it('repairs a structurally valid Skill plan that uses names outside the active catalogs', async () => {
    const deps = dependencies()
    const openTools = deps.openTools
    deps.openTools = async options => {
      const runtime = await openTools(options)
      return {
        ...runtime,
        activeContext: () => options.skillName ? {
          skill: alpha,
          references: [{ path: 'references/rules.md', bytes: 5 }],
          activation: 'manual' as const,
          execution: {
            planRequired: true,
            verificationRequired: true,
            maxRevisions: 1 as const,
          },
        } : undefined,
        readReferences: async (paths: string[]) => paths.map(path => ({
          path,
          content: 'rules',
          bytes: 5,
        })),
      }
    }
    let planningAttempts = 0
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.includes('Repair the previous Skill plan')) {
        planningAttempts += 1
        return {
          output: {
            goal: '读取规则并完成任务',
            steps: [{
              id: 'read',
              instruction: '读取规则',
              requiredReferences: ['references/rules.md'],
              requiredTools: [],
            }],
            outputRequirements: ['遵守规则'],
            verificationCriteria: ['规则已读取'],
          },
        }
      }
      if (prompt.startsWith('Create a bounded execution plan')) {
        planningAttempts += 1
        return {
          output: {
            goal: '读取规则并完成任务',
            steps: [{
              id: 'read',
              instruction: '读取规则',
              requiredReferences: ['references/rules.md'],
              requiredTools: ['readSkillReference'],
            }],
            outputRequirements: ['遵守规则'],
            verificationCriteria: ['规则已读取'],
          },
        }
      }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }
      return { text: 'done', toolResults: [], content: [] }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      skillMode: 'manual',
      skillName: 'Alpha',
    })

    const result = await runtime.run({
      objective: 'Do the alpha task',
      modelMessages: [],
      maxSteps: 5,
    })

    expect(planningAttempts).toBe(2)
    expect(result).toMatchObject({
      kind: 'completed',
      skillRun: {
        loadedReferences: ['references/rules.md'],
        requiredTools: [],
        validation: { passed: true },
      },
    })
    await runtime.close()
  })
})
