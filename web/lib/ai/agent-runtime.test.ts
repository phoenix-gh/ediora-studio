import { tool, type ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { applyAgentToolPolicy } from './agent-tool-policy'
import { agentSkillRunAudit, openAgentRuntime, planningTools, type AgentRuntimeDependencies, type AgentSessionEventDraft } from './agent-runtime'
import type { GlobalAgentToolOptions } from './global-chat-tools'
import type { RegisteredSkill } from '../skills/registry'

const alpha: RegisteredSkill = {
  name: 'Alpha', description: 'Handles alpha work', version: '1.0.0', source: 'uploaded',
  digest: 'a'.repeat(64), enabled: true, reviewState: 'approved', standardCompatible: true, diagnostics: [],
  instructions: '# Alpha workflow', content: '# Alpha workflow', directory: '/skills/alpha',
  packageFiles: [], requestedAllowedTools: [],
}

type Executable = {
  execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
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
      const tools = applyAgentToolPolicy(base, {
        policy: options.approvalPolicy ?? 'interactive',
        beforeToolExecute: options.beforeToolExecute,
        onAudit: options.onToolAudit,
      })
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
    mcpEndpoint: 'http://localhost:8000/mcp',
    imageGenerator: {
      generate: async () => ({
        asset_id: 1,
        asset_url: '/api/uploads/direct.png',
        title: 'direct',
        directory: '',
        model: 'gpt-image-1',
      }),
    },
    model: 'fake-model' as never,
    approvalPolicy,
    skillMode: 'auto' as const,
    dependencies: deps,
  }
}

describe('shared Agent runtime', () => {
  it('requires an accepted complete_goal declaration and follows up without business-count instructions', async () => {
    const deps = dependencies()
    deps.generate = vi.fn()
      .mockResolvedValueOnce({
        text: '我先到这里', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [],
        responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '我先到这里' }] }],
      })
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.messages).toEqual([
          { role: 'user', content: '完成保存的自然语言目标' },
          expect.objectContaining({ role: 'assistant' }),
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('完成保存的自然语言目标'),
          }),
        ])
        expect(JSON.stringify(input.messages)).not.toContain('required drafts')
        expect(JSON.stringify(input.messages)).not.toContain('target_count')
        const completeGoal = (input.tools as Record<string, Executable>).complete_goal
        const declaration = {
          status: 'completed', summary: '既定目标已经完成',
          evidence: [{ kind: 'tool_call', id: 'save_draft', claim: '草稿已经保存' }],
        }
        const output = await completeGoal.execute(declaration, { toolCallId: 'goal-1' })
        return {
          text: '', finishReason: 'tool-calls', steps: [{}],
          toolCalls: [{ type: 'tool-call', toolCallId: 'goal-1', toolName: 'complete_goal', input: declaration }],
          toolResults: [{ type: 'tool-result', toolCallId: 'goal-1', toolName: 'complete_goal', output }],
          content: [], responseMessages: [],
        }
      }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), mode: 'job', automaticSelection: false,
    })

    const result = await runtime.run({
      objective: '完成保存的自然语言目标',
      modelMessages: [{ role: 'user', content: '完成保存的自然语言目标' }],
      maxSteps: 5,
      requireGoalCompletion: true,
      verifyGoalCompletion: declaration => {
        expect(declaration).toEqual({
          status: 'completed', summary: '既定目标已经完成',
        })
      },
    })

    expect(result.goalCompletion).toEqual({
      status: 'completed', summary: '既定目标已经完成',
    })
    expect(result.text).toBe('既定目标已经完成')
    expect(deps.generate).toHaveBeenCalledTimes(2)
    await runtime.close()
  })

  it('keeps an accepted completion successful when the model output getter is unavailable', async () => {
    const deps = dependencies()
    const declaration = {
      status: 'completed' as const, summary: '既定目标已经完成', evidence: [],
    }
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const completeGoal = (input.tools as Record<string, Executable>).complete_goal
      const output = await completeGoal.execute(declaration, { toolCallId: 'goal-without-output' })
      const response = {
        text: '', finishReason: 'tool-calls', steps: [{}],
        toolCalls: [{ type: 'tool-call', toolCallId: 'goal-without-output', toolName: 'complete_goal', input: declaration }],
        toolResults: [{ type: 'tool-result', toolCallId: 'goal-without-output', toolName: 'complete_goal', output }],
        content: [], responseMessages: [],
      }
      Object.defineProperty(response, 'output', {
        get() { throw new Error('No output generated') },
      })
      return response
    }) as unknown as AgentRuntimeDependencies['generate']
    const messages: AgentSessionEventDraft[] = []
    const modelDirections: string[] = []
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      mode: 'job',
      automaticSelection: false,
      onMessage: event => { modelDirections.push(event.direction) },
      onSessionEvent: event => { messages.push(event) },
    })

    await expect(runtime.run({
      objective: '完成任务', modelMessages: [], maxSteps: 2,
      requireGoalCompletion: true,
    })).resolves.toMatchObject({
      goalCompletion: {
        status: 'completed', summary: '既定目标已经完成',
      },
    })
    expect(messages.some(event => event.type === 'assistant/message')).toBe(true)
    expect(modelDirections).toContain('model_response')
    expect(modelDirections).not.toContain('model_error')
    await runtime.close()
  })

  it('keeps the Harness completion tool out of Skill capabilities and plans', async () => {
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', dependencies()), mode: 'job', automaticSelection: false,
    })

    expect(Object.keys(runtime.tools)).toContain('complete_goal')
    expect(runtime.capabilitySnapshot().tools.map(tool => tool.name)).not.toContain('complete_goal')
    expect(planningTools(runtime.tools).map(tool => tool.name)).not.toContain('complete_goal')
    await runtime.close()
  })

  it('returns an Agent-owned blocked declaration without treating it as completed', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const completeGoal = (input.tools as Record<string, Executable>).complete_goal
      const declaration = {
        status: 'blocked', summary: '缺少必要授权', evidence: [],
        remainingWork: ['等待用户授权'],
      }
      const output = await completeGoal.execute(declaration, { toolCallId: 'goal-blocked' })
      return {
        text: '', finishReason: 'tool-calls', steps: [{}],
        toolCalls: [{ type: 'tool-call', toolCallId: 'goal-blocked', toolName: 'complete_goal', input: declaration }],
        toolResults: [{ type: 'tool-result', toolCallId: 'goal-blocked', toolName: 'complete_goal', output }],
        content: [], responseMessages: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), mode: 'job', automaticSelection: false,
    })

    const result = await runtime.run({
      objective: '需要授权的任务', modelMessages: [], maxSteps: 3,
      requireGoalCompletion: true,
    })

    expect(result.goalCompletion).toEqual({
      status: 'blocked', summary: '缺少必要授权',
      remainingWork: ['等待用户授权'],
    })
    await runtime.close()
  })

  it('fails when the durable step budget ends without a completion declaration', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async () => ({
      text: '尚未声明完成', finishReason: 'stop', steps: [{}],
      toolCalls: [], toolResults: [], content: [],
      responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '尚未声明完成' }] }],
    })) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), mode: 'job', automaticSelection: false,
    })

    await expect(runtime.run({
      objective: '必须完成的任务', modelMessages: [], maxSteps: 2,
      requireGoalCompletion: true,
    })).rejects.toThrow('Agent ended without declaring goal completion')
    expect(deps.generate).toHaveBeenCalledTimes(2)
    await runtime.close()
  })

  it('captures the final visible Tools and current policy for a Job runtime', async () => {
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', dependencies()),
      mode: 'job',
      automaticSelection: false,
    })

    expect(runtime.capabilitySnapshot()).toMatchObject({
      schemaVersion: 1,
      mode: 'job',
      skill: null,
      tools: [
        expect.objectContaining({ name: 'save_draft' }),
        expect.objectContaining({ name: 'search_assets' }),
      ],
      policy: { approvalPolicy: 'automatic', allowedToolNames: null },
    })
    await runtime.close()
  })

  it('exposes the same global tool names to interactive and automatic adapters', async () => {
    const deps = dependencies()
    const chat = await openAgentRuntime(openOptions('interactive', deps))
    const background = await openAgentRuntime(openOptions('automatic', deps))

    expect(Object.keys(background.tools).sort()).toEqual(['save_draft', 'search_assets'])
    expect(Object.keys(background.tools).sort()).toEqual(Object.keys(chat.tools).sort())
    await chat.close()
    await background.close()
  })

  it('hides tools outside an explicit Agent tool allowlist', async () => {
    const deps = dependencies()
    const openTools = deps.openTools
    deps.openTools = async options => {
      const runtime = await openTools(options)
      return {
        ...runtime,
        tools: {
          ...runtime.tools,
          update_draft: tool({
            inputSchema: z.object({}),
            execute: async () => ({ id: 9 }),
          }),
        },
      }
    }
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
      allowedToolNames: ['search_assets', 'save_draft'],
    })

    expect(Object.keys(runtime.tools).sort()).toEqual(['save_draft', 'search_assets'])
    await expect(runtime.run({
      objective: '只允许读取素材并保存草稿', modelMessages: [], maxSteps: 1,
      requiredTools: ['update_draft'],
    })).rejects.toThrow('Required Agent tool is unavailable: update_draft')
    await runtime.close()
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

  it('uses a text-compatible selector when provider JSON parsing would fail', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      if (Object.prototype.hasOwnProperty.call(input, 'output')) {
        throw new Error('No object generated: could not parse the response.')
      }
      return {
        text: '{"skillName":"Alpha","continueRestored":false}',
        toolResults: [], content: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime(openOptions('automatic', deps))

    await expect(runtime.prepare('Do the alpha task')).resolves.toMatchObject({
      skill: { name: 'Alpha' }, activation: 'automatic',
    })
    await runtime.close()
  })

  it('continues without a Skill when automatic selection has no clear match', async () => {
    const runtime = await openAgentRuntime(openOptions('automatic', dependencies()))

    await expect(runtime.prepare('A plain unrelated question')).resolves.toBeUndefined()
    expect(runtime.selectedSkill).toBeUndefined()
    expect(Object.keys(runtime.tools).sort()).toEqual(['save_draft', 'search_assets'])
    await runtime.close()
  })

  it('passes the Skill catalog to delegated automatic execution', async () => {
    let active = false
    let executionInstructions = ''
    const deps = dependencies()
    deps.openTools = async () => ({
      tools: {
        loadSkill: tool({
          description: 'Load an enabled Skill.',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            active = name === alpha.name
            return { name, instructions: alpha.instructions }
          },
        }),
      } satisfies ToolSet,
      catalogContext: 'Enabled Skills available for automatic activation:\n- Alpha: Handles alpha work',
      snapshot: () => ({
        source: active ? 'automatic' as const : undefined,
        activeSkillName: active ? alpha.name : undefined,
        referenceCount: 0,
        readReferenceCount: 0,
      }),
      activeContext: () => active ? {
        skill: alpha,
        references: [],
        activation: 'automatic' as const,
        execution: { planRequired: true, verificationRequired: true, maxRevisions: 1 as const },
      } : undefined,
      readReferences: async () => [],
      close: async () => undefined,
    })
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      executionInstructions = String(input.instructions ?? '')
      const loadSkill = (input.tools as Record<string, Executable>).loadSkill
      const output = await loadSkill.execute({ name: alpha.name }, { toolCallId: 'skill-1' })
      return {
        text: 'done',
        toolResults: [{ toolName: 'loadSkill', toolCallId: 'skill-1', output }],
        content: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']

    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
    })
    await runtime.run({ objective: '写作任务', modelMessages: [], maxSteps: 5 })

    expect(executionInstructions).toContain('Enabled Skills available for automatic activation:')
    expect(executionInstructions).toContain(
      'Decide yourself whether a Skill is relevant to the task.',
    )
    expect(executionInstructions).toContain('Skill selection is not a prerequisite for completing the task.')
    expect(runtime.snapshot()).toMatchObject({ activeSkillName: 'Alpha', source: 'automatic' })
    await runtime.close()
  })

  it('lets delegated execution complete without loading a Skill', async () => {
    let saveCalled = false
    let executionInstructions = ''
    const deps = dependencies()
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      executionInstructions = String(input.instructions ?? '')
      const saveDraft = (input.tools as Record<string, Executable>).save_draft
      const output = await saveDraft.execute({}, { toolCallId: 'save-1' })
      saveCalled = true
      return {
        text: '已完成',
        toolResults: [{ toolName: 'save_draft', toolCallId: 'save-1', output }],
        content: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']

    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
    })
    const result = await runtime.run({
      objective: '用户提到 human-social-copy，但是否使用由你自行判断。',
      modelMessages: [], maxSteps: 5, requiredTools: ['save_draft'],
    })

    expect(saveCalled).toBe(true)
    expect(result.selectedSkill).toBeUndefined()
    expect(runtime.selectedSkill).toBeUndefined()
    expect(executionInstructions).toContain(
      'Skill selection is not a prerequisite for completing the task.',
    )
    await runtime.close()
  })

  it('records each delegated model request and response', async () => {
    const messages: Array<{ phase: string; direction: string; payload: Record<string, unknown> }> = []
    const deps = dependencies()
    deps.generate = vi.fn(async (input: Record<string, unknown>) => ({
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
      toolResults: [],
      output: { decision: 'continue' },
      request: input,
    })) as unknown as AgentRuntimeDependencies['generate']

    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
      onMessage: event => { messages.push(event) },
    })
    await runtime.run({ objective: '记录这次执行', modelMessages: [], maxSteps: 5 })

    expect(messages.map(message => [message.phase, message.direction])).toEqual([
      ['execute', 'model_request'],
      ['execute', 'model_response'],
    ])
    expect(messages[0].payload).toMatchObject({
      instructions: expect.stringContaining('Skill selection is not a prerequisite'),
    })
    expect(messages[1].payload).toMatchObject({
      text: 'done', output: { decision: 'continue' },
    })
    await runtime.close()
  })

  it('emits typed step, request, assistant, and terminal step events without swallowing trace failures', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async () => ({
      text: 'done',
      reasoning: '先确认',
      content: [],
      toolResults: [],
      usage: { inputTokens: 2, outputTokens: 3 },
    })) as unknown as AgentRuntimeDependencies['generate']
    const events: AgentSessionEventDraft[] = []
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
      turn: 3,
      onSessionEvent: event => { events.push(event) },
    })

    await runtime.run({ objective: '记录 canonical 轨迹', modelMessages: [], maxSteps: 1 })

    expect(events.map(event => event.type)).toEqual([
      'step/start', 'request/header', 'assistant/message', 'step/end',
    ])
    expect(events[0]).toMatchObject({ turn: 3, step: 1, data: { turn: 3, step: 1 } })
    expect(events[2]).toMatchObject({
      type: 'assistant/message',
      data: { blocks: [{ kind: 'reasoning', text: '先确认' }, { kind: 'text', text: 'done' }] },
    })
    await runtime.close()

    const failing = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
      onSessionEvent: async () => { throw new Error('trajectory store unavailable') },
    })
    await expect(failing.run({ objective: 'trace failure', modelMessages: [], maxSteps: 1 })).rejects.toThrow('trajectory store unavailable')
    await failing.close()
  })

  it('runs an activated Skill through plan, execution, validation, and shared audit', async () => {
    const deps = dependencies()
    let validationPrompt = ''
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
        validationPrompt = prompt
        return { output: { passed: true, violations: [] } }
      }
      return {
        text: 'validated output',
        toolResults: [{
          toolName: 'search_assets', toolCallId: 'call-search',
          input: { prompt: '来自工具的真实输入' },
          output: [{ id: 11, description: '来自工具的真实字段' }],
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
    expect(validationPrompt).toContain('来自工具的真实字段')
    expect(validationPrompt).toContain('来自工具的真实输入')
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

  it('keeps Chat core tools active even when the Skill plan omits them', async () => {
    const deps = dependencies()
    let activeTools: unknown
    const openTools = deps.openTools
    deps.openTools = async options => {
      const runtime = await openTools(options)
      return {
        ...runtime,
        tools: {
          ...runtime.tools,
          generateImage: tool({
            inputSchema: z.object({ prompt: z.string() }),
            execute: async () => ({ asset_id: 1 }),
          }),
        },
      }
    }
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
      ...openOptions('automatic', deps),
      skillMode: 'manual',
      skillName: 'Alpha',
      alwaysAvailableToolNames: ['generateImage'],
    })

    await runtime.run({
      objective: '生成一张图', modelMessages: [], maxSteps: 5,
    })

    expect(activeTools).toEqual(['search_assets', 'generateImage'])
  })

  it('reports the final finish reason and executed step count without an active Skill', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async () => ({
      text: '', toolResults: [], content: [], finishReason: 'tool-calls',
      steps: Array.from({ length: 5 }, () => ({})),
    })) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await expect(runtime.run({
      objective: 'Keep researching', modelMessages: [], maxSteps: 5,
    })).resolves.toMatchObject({
      kind: 'completed', finishReason: 'tool-calls', stepCount: 5,
    })
  })

  it('continues after a provider reports stop for a completed tool-only step', async () => {
    const deps = dependencies()
    deps.generate = vi.fn()
      .mockResolvedValueOnce({
        text: '', finishReason: 'stop', steps: [{}],
        toolCalls: [{
          type: 'tool-call', toolCallId: 'skill-1', toolName: 'loadSkill',
          input: { name: 'Alpha' },
        }],
        toolResults: [{
          type: 'tool-result', toolCallId: 'skill-1', toolName: 'loadSkill',
          output: { name: 'Alpha', instructions: '# Alpha workflow' },
        }],
        content: [],
        responseMessages: [
          { role: 'assistant', content: [{
            type: 'tool-call', toolCallId: 'skill-1', toolName: 'loadSkill',
            input: { name: 'Alpha' },
          }] },
          { role: 'tool', content: [{
            type: 'tool-result', toolCallId: 'skill-1', toolName: 'loadSkill',
            output: { type: 'json', value: { name: 'Alpha' } },
          }] },
        ],
      })
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.messages).toHaveLength(2)
        return {
          text: '任务继续执行并完成', finishReason: 'stop', steps: [{}],
          toolCalls: [], toolResults: [], content: [{ type: 'text', text: '任务继续执行并完成' }],
          responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '任务继续执行并完成' }] }],
        }
      }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await expect(runtime.run({
      objective: '加载 Skill 后继续完成任务', modelMessages: [], maxSteps: 5,
    })).resolves.toMatchObject({
      kind: 'completed', text: '任务继续执行并完成', finishReason: 'stop', stepCount: 2,
    })
    expect(deps.generate).toHaveBeenCalledTimes(2)
  })

  it('recovers once when a provider reports an empty stop before any tool call', async () => {
    const deps = dependencies()
    deps.generate = vi.fn()
      .mockResolvedValueOnce({
        text: '', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [], responseMessages: [],
      })
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.messages).toEqual([
          { role: 'user', content: '创建并保存草稿' },
          expect.objectContaining({ role: 'user' }),
        ])
        return {
          text: '草稿已保存', finishReason: 'stop', steps: [{}],
          toolCalls: [], toolResults: [], content: [{ type: 'text', text: '草稿已保存' }],
          responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '草稿已保存' }] }],
        }
      }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await expect(runtime.run({
      objective: '创建并保存草稿',
      modelMessages: [{ role: 'user', content: '创建并保存草稿' }],
      maxSteps: 5,
    })).resolves.toMatchObject({
      kind: 'completed', text: '草稿已保存', finishReason: 'stop', stepCount: 2,
    })
    expect(deps.generate).toHaveBeenCalledTimes(2)
  })

  it('stops after one recovery when the provider keeps returning empty stops', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async () => ({
      text: '', finishReason: 'stop', steps: [{}],
      toolCalls: [], toolResults: [], content: [], responseMessages: [],
    })) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await expect(runtime.run({
      objective: '创建并保存草稿', modelMessages: [], maxSteps: 5,
    })).resolves.toMatchObject({
      kind: 'completed', text: '', finishReason: 'stop', stepCount: 2,
    })
    expect(deps.generate).toHaveBeenCalledTimes(2)
  })

  it('processes queued follow-up work before marking the Agent run complete', async () => {
    const deps = dependencies()
    let taskComplete = false
    deps.generate = vi.fn()
      .mockResolvedValueOnce({
        text: '素材已经读取，接下来保存草稿', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [{
          type: 'text', text: '素材已经读取，接下来保存草稿',
        }],
        responseMessages: [{
          role: 'assistant', content: [{ type: 'text', text: '素材已经读取，接下来保存草稿' }],
        }],
      })
      .mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.messages).toEqual([
          { role: 'user', content: '读取素材并保存草稿' },
          expect.objectContaining({ role: 'assistant' }),
          expect.objectContaining({ role: 'user' }),
        ])
        taskComplete = true
        return {
          text: '草稿已经保存', finishReason: 'stop', steps: [{}],
          toolCalls: [], toolResults: [], content: [{ type: 'text', text: '草稿已经保存' }],
          responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '草稿已经保存' }] }],
        }
      }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await expect(runtime.run({
      objective: '读取素材并保存草稿',
      modelMessages: [{ role: 'user', content: '读取素材并保存草稿' }],
      maxSteps: 5,
      getFollowUpMessages: async () => taskComplete ? [] : [{
        role: 'user', content: '任务尚未完成，请继续保存草稿',
      }],
    })).resolves.toMatchObject({
      kind: 'completed', text: '草稿已经保存', finishReason: 'stop', stepCount: 2,
    })
    expect(deps.generate).toHaveBeenCalledTimes(2)
  })

  it('keeps follow-up work bounded by the Agent step limit', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async () => ({
      text: '仍在处理中', finishReason: 'stop', steps: [{}],
      toolCalls: [], toolResults: [], content: [{ type: 'text', text: '仍在处理中' }],
      responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '仍在处理中' }] }],
    })) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await expect(runtime.run({
      objective: '完成任务', modelMessages: [], maxSteps: 2,
      getFollowUpMessages: async () => [{ role: 'user', content: '继续' }],
    })).resolves.toMatchObject({
      kind: 'completed', finishReason: 'stop', stepCount: 2,
    })
    expect(deps.generate).toHaveBeenCalledTimes(2)
  })

  it('lets an authoritative follow-up provider stop without fallback recovery', async () => {
    const deps = dependencies()
    deps.generate = vi.fn(async () => ({
      text: '', finishReason: 'stop', steps: [{}],
      toolCalls: [{ type: 'tool-call', toolCallId: 'save-1', toolName: 'save_draft', input: {} }],
      toolResults: [{ type: 'tool-result', toolCallId: 'save-1', toolName: 'save_draft', output: {} }],
      content: [],
      responseMessages: [{ role: 'assistant', content: [] }],
    })) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), automaticSelection: false,
    })

    await runtime.run({
      objective: '保存草稿', modelMessages: [], maxSteps: 5,
      getFollowUpMessages: async () => [],
    })

    expect(deps.generate).toHaveBeenCalledTimes(1)
  })

  it('processes queued follow-up work while executing a manually selected Skill', async () => {
    const deps = dependencies()
    let taskComplete = false
    let executionCalls = 0
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) {
        return {
          output: {
            goal: '读取素材并保存草稿',
            steps: [{
              id: 'deliver', instruction: '保存草稿', requiredReferences: [], requiredTools: [],
            }],
            outputRequirements: ['草稿已保存'],
            verificationCriteria: ['确认任务完成'],
          },
        }
      }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }

      executionCalls += 1
      if (executionCalls === 1) {
        expect(input.activeTools).toContain('save_draft')
        return {
          text: '素材已经读取，接下来保存草稿', finishReason: 'stop', steps: [{}],
          toolCalls: [], toolResults: [], content: [{
            type: 'text', text: '素材已经读取，接下来保存草稿',
          }],
          responseMessages: [{
            role: 'assistant', content: [{ type: 'text', text: '素材已经读取，接下来保存草稿' }],
          }],
        }
      }

      expect(input.messages).toEqual([
        { role: 'user', content: '读取素材并保存草稿' },
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'user' }),
      ])
      taskComplete = true
      return {
        text: '草稿已经保存', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [{ type: 'text', text: '草稿已经保存' }],
        responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: '草稿已经保存' }] }],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), skillMode: 'manual', skillName: 'Alpha',
    })

    await expect(runtime.run({
      objective: '读取素材并保存草稿',
      modelMessages: [{ role: 'user', content: '读取素材并保存草稿' }],
      maxSteps: 5,
      requiredTools: ['save_draft'],
      getFollowUpMessages: async () => taskComplete ? [] : [{
        role: 'user', content: '任务尚未完成，请继续保存草稿',
      }],
    })).resolves.toMatchObject({
      kind: 'completed', text: '草稿已经保存', finishReason: 'stop', stepCount: 2,
      selectedSkill: { name: 'Alpha' },
    })
    expect(executionCalls).toBe(2)
  })

  it('counts a replayed approved side effect as Skill evidence without executing it twice', async () => {
    const deps = dependencies()
    let saveCalls = 0
    const plan = {
      goal: '完成并保存文章',
      steps: [{
        id: 'save', instruction: '保存最终文章', requiredReferences: [], requiredTools: ['save_draft'],
      }],
      outputRequirements: ['文章已保存'],
      verificationCriteria: ['保存工具返回真实 ID'],
    }
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) return { output: plan }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }

      const saveDraft = (input.tools as Record<string, Executable>).save_draft
      await saveDraft.execute({}, { toolCallId: 'save-resumed' })
      saveCalls += 1
      return {
        text: '文章已经保存', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [], responseMessages: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']

    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), skillMode: 'manual', skillName: 'Alpha',
    })
    const result = await runtime.run({
      objective: '完成并保存文章', modelMessages: [], maxSteps: 5,
    })

    expect(saveCalls).toBe(1)
    expect(result.text).toBe('文章已经保存')
    expect(result.skillRun?.steps).toEqual([
      expect.objectContaining({ id: 'save', status: 'completed' }),
    ])
    await runtime.close()
  })

  it('does not add stop recovery turns to an ordinary manually selected Skill run', async () => {
    const deps = dependencies()
    let executionCalls = 0
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) {
        return {
          output: {
            goal: '完成任务',
            steps: [{ id: 'deliver', instruction: '交付', requiredReferences: [], requiredTools: [] }],
            outputRequirements: [], verificationCriteria: [],
          },
        }
      }
      if (prompt.startsWith('Return valid JSON only in exactly this shape')) {
        return { output: { passed: true, violations: [] } }
      }
      executionCalls += 1
      return {
        text: '', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [], responseMessages: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), skillMode: 'manual', skillName: 'Alpha',
    })

    await runtime.run({ objective: '完成任务', modelMessages: [], maxSteps: 5 })

    expect(executionCalls).toBe(1)
  })

  it('shares one max-step budget across Skill execution retries', async () => {
    const deps = dependencies()
    let executionCalls = 0
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) {
        return {
          output: {
            goal: '检索并完成任务',
            steps: [{
              id: 'research', instruction: '检索', requiredReferences: [],
              requiredTools: ['search_assets'],
            }],
            outputRequirements: [], verificationCriteria: [],
          },
        }
      }
      executionCalls += 1
      return {
        text: '未检索', finishReason: 'stop', steps: [{}, {}],
        toolCalls: [], toolResults: [], content: [], responseMessages: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), skillMode: 'manual', skillName: 'Alpha',
    })

    await expect(runtime.run({
      objective: '检索并完成任务', modelMessages: [], maxSteps: 2,
      getFollowUpMessages: async () => [],
    })).rejects.toThrow('Agent execution step limit reached (2)')
    expect(executionCalls).toBe(1)
  })

  it('preserves the existing per-execution Skill retry budget without a follow-up provider', async () => {
    const deps = dependencies()
    let executionCalls = 0
    deps.generate = vi.fn(async (input: Record<string, unknown>) => {
      const prompt = typeof input.prompt === 'string' ? input.prompt : ''
      if (prompt.startsWith('Create a bounded execution plan')) {
        return {
          output: {
            goal: '检索并完成任务',
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
      executionCalls += 1
      return executionCalls === 1 ? {
        text: '尚未检索', finishReason: 'stop', steps: [{}],
        toolCalls: [], toolResults: [], content: [], responseMessages: [],
      } : {
        text: '检索完成', finishReason: 'stop', steps: [{}],
        toolCalls: [{
          type: 'tool-call', toolCallId: 'search-1', toolName: 'search_assets', input: {},
        }],
        toolResults: [{
          type: 'tool-result', toolCallId: 'search-1', toolName: 'search_assets', output: [],
        }],
        content: [], responseMessages: [],
      }
    }) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps), skillMode: 'manual', skillName: 'Alpha',
    })

    await expect(runtime.run({
      objective: '检索并完成任务', modelMessages: [], maxSteps: 1,
    })).resolves.toMatchObject({ kind: 'completed', text: '检索完成', stepCount: 2 })
    expect(executionCalls).toBe(2)
  })

  it('passes run identity only to the tool transport, not to the model request', async () => {
    const deps = dependencies()
    const openTools = vi.fn(deps.openTools)
    deps.openTools = openTools
    deps.generate = vi.fn(async () => ({
      text: 'done', toolResults: [], content: [], finishReason: 'stop', steps: [{}],
    })) as unknown as AgentRuntimeDependencies['generate']
    const runtime = await openAgentRuntime({
      ...openOptions('automatic', deps),
      automaticSelection: false,
      dailyCreationRunId: 83,
    })
    const objective = '只按这条保存的提示词执行。'

    await runtime.run({
      objective,
      modelMessages: [{ role: 'user', content: objective }],
      maxSteps: 5,
    })

    expect(openTools).toHaveBeenCalledWith(expect.objectContaining({
      dailyCreationRunId: 83,
    }))
    const modelInput = vi.mocked(deps.generate).mock.calls[0]?.[0]
    expect(modelInput?.messages).toEqual([{ role: 'user', content: objective }])
    expect(modelInput).not.toHaveProperty('dailyCreationRunId')
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
