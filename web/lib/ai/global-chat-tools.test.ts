import { tool, type ToolSet } from 'ai'
import { createMCPClient } from '@ai-sdk/mcp'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  toolsFromDefinitions: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({
    listTools: mcp.listTools,
    toolsFromDefinitions: mcp.toolsFromDefinitions,
    close: mcp.close,
  })),
}))

import {
  createChatSkillRuntime,
  createSkillReferenceReader,
  imageGenerationInputSchema,
  openGlobalAgentTools,
  requiresToolApproval,
} from './global-chat-tools'
import type { AgentToolAudit } from './agent-runtime-types'

const alpha = {
  name: 'Alpha', description: 'Alpha description', version: '1.0.0', source: 'builtin' as const,
  digest: 'a'.repeat(64), enabled: true, reviewState: 'approved' as const,
  standardCompatible: true, diagnostics: [] as const,
  instructions: '# Alpha rules', content: '# Alpha rules', directory: '/skills/alpha',
  packageFiles: [], requestedAllowedTools: [],
}

function runtimeDependencies() {
  return {
    listEnabled: async () => [alpha],
    getEnabled: async (name: string) => name === 'Alpha' ? alpha : null,
    listReferences: async (name: string) => name === 'Alpha' ? [{ path: 'references/rules.md', bytes: 5 }] : [],
    readReference: async (name: string, path: string) => ({ path, content: `${name} rules`, bytes: 5 }),
    loadPreloadContext: async (name: string) => ({
      name,
      instructions: '# Alpha rules',
      references: [{ path: 'references/rules.md', content: 'Alpha rules', bytes: 5 }],
    }),
    loadManifest: async () => ({
      preloadReferences: ['references/rules.md'],
      execution: { planRequired: true, verificationRequired: true, maxRevisions: 1 as const },
    }),
  }
}

async function executeTool(tool: unknown, input: unknown) {
  return (tool as { execute: (input: unknown, options: never) => Promise<unknown> }).execute(input, {} as never)
}

function mcpContract(name: string) {
  const readOnly = /^(list|get|search|read|fetch|find)_/.test(name)
  return {
    name,
    description: readOnly ? `Read ${name} from Ediora.` : `Write with ${name} in Ediora.`,
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: name === 'upload_image_from_url',
    },
    _meta: {
      'dev.ediora/tool': {
        namespace: name.includes('draft') ? 'drafts' : 'information_sources',
        version: '1',
        approval: readOnly ? 'never' : 'writes',
        concurrency: readOnly ? 'parallel-safe' : 'serialized',
        retry: readOnly ? 'safe' : 'claim-backed',
      },
    },
  }
}

function setMcpTools(tools: ToolSet) {
  mcp.listTools.mockResolvedValue({ tools: Object.keys(tools).map(mcpContract) })
  mcp.toolsFromDefinitions.mockReturnValue(tools)
}

describe('global Chat tool policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mcp.listTools.mockReset()
    mcp.toolsFromDefinitions.mockReset()
    mcp.close.mockReset()
  })

  it('requires approval for MCP tools with a sensitive action verb', () => {
    expect(requiresToolApproval('update_draft')).toBe(true)
    expect(requiresToolApproval('attach_creative_asset_to_draft')).toBe(true)
    expect(requiresToolApproval('upload_image_from_url')).toBe(true)
    expect(requiresToolApproval('search_ref_materials')).toBe(false)
    expect(requiresToolApproval('list_publish_accounts')).toBe(false)
  })

  it('does not require approval for direct image generation', () => {
    expect(requiresToolApproval('generateImage')).toBe(false)
    expect(requiresToolApproval('readSkillReference')).toBe(false)
  })

  it('opens one automatic global catalog with sensitive tools auto-approved and audited', async () => {
    const audits: AgentToolAudit[] = []
    setMcpTools({
      save_item: tool({
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => ({ id: 9, value }),
      }),
      list_items: tool({
        inputSchema: z.object({}),
        execute: async () => [],
      }),
    } satisfies ToolSet)

    const runtime = await openGlobalAgentTools({
      mcpEndpoint: 'http://localhost:8000/mcp',
      imageGenerator: { generate: vi.fn() },
      approvalPolicy: 'automatic',
      onToolAudit: event => { audits.push(event) },
    })
    const save = runtime.tools.save_item as {
      needsApproval?: boolean
      execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
    }

    expect(runtime.toolRegistry().contracts.get('list_items')).toMatchObject({
      namespace: 'information_sources',
      source: 'mcp',
      annotations: { readOnly: true, approval: 'never' },
    })
    expect(Object.keys(runtime.tools)).toEqual(expect.arrayContaining([
      'list_items', 'generateImage', 'loadSkill', 'readSkillReference',
    ]))
    expect(save.needsApproval).toBe(false)
    await expect(save.execute({ value: 'shared' }, { toolCallId: 'call-global' }))
      .resolves.toEqual({ id: 9, value: 'shared' })
    expect(audits.at(-1)).toMatchObject({
      toolName: 'save_item', autoApproved: true, status: 'succeeded',
    })
    await runtime.close()
    expect(mcp.close).toHaveBeenCalledOnce()
  })

  it('sends scheduled-run identity as an MCP transport header only', async () => {
    setMcpTools({})

    const runtime = await openGlobalAgentTools({
      mcpEndpoint: 'http://localhost:8000/mcp',
      imageGenerator: { generate: vi.fn() },
      approvalPolicy: 'automatic',
      dailyCreationRunId: 83,
    })

    expect(vi.mocked(createMCPClient)).toHaveBeenLastCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:8000/mcp',
        headers: {
          'X-Agent-Mode': 'scheduled',
          'X-Daily-Creation-Run-Id': '83',
        },
      },
    })
    await runtime.close()
  })

  it('sends Chat session identity as MCP transport headers only', async () => {
    setMcpTools({})

    const runtime = await openGlobalAgentTools({
      mcpEndpoint: 'http://localhost:8000/mcp',
      imageGenerator: { generate: vi.fn() },
      sessionId: 92,
      agentMode: 'chat',
    })

    expect(vi.mocked(createMCPClient)).toHaveBeenLastCalledWith({
      transport: {
        type: 'http',
        url: 'http://localhost:8000/mcp',
        headers: {
          'X-Agent-Mode': 'chat',
          'X-Agent-Session-Id': '92',
        },
      },
    })
    await runtime.close()
  })

  it('hides remote image upload tools from scheduled Agents', async () => {
    setMcpTools({
      upload_image_from_url: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
      upload_image_from_path: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
      list_drafts: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
      get_draft: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
      attach_creative_asset_to_draft: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
    })

    const runtime = await openGlobalAgentTools({
      mcpEndpoint: 'http://localhost:8000/mcp',
      imageGenerator: { generate: vi.fn() },
      approvalPolicy: 'automatic',
      dailyCreationRunId: 83,
    })

    expect(runtime.tools.upload_image_from_url).toBeUndefined()
    expect(runtime.tools.upload_image_from_path).toBeUndefined()
    expect(runtime.tools.list_drafts).toBeDefined()
    expect(runtime.tools.get_draft).toBeDefined()
    expect(runtime.tools.attach_creative_asset_to_draft).toBeDefined()
    expect(runtime.toolRegistry().contracts.has('upload_image_from_url')).toBe(false)
    expect(runtime.toolRegistry().contracts.has('upload_image_from_path')).toBe(false)
    await runtime.close()
  })

  it('scopes Skill reference reads, caches repeats, and shares one byte budget', async () => {
    const readReference = vi.fn(async (skillName: string, path: string) => ({
      path,
      content: `${skillName}:${path}`,
      bytes: 3,
    }))
    const read = createSkillReferenceReader({ skillName: 'Alpha', readReference, maxBytes: 5 })

    await expect(read({ path: 'references/one.md' })).resolves.toEqual({
      path: 'references/one.md', content: 'Alpha:references/one.md', bytes: 3,
    })
    await expect(read({ path: 'references/one.md' })).resolves.toEqual({
      path: 'references/one.md', content: 'Alpha:references/one.md', bytes: 3,
    })
    await expect(read({ path: 'references/two.md' })).rejects.toMatchObject({ code: 'too_large' })
    expect(readReference).toHaveBeenCalledTimes(2)
    expect(readReference).toHaveBeenNthCalledWith(1, 'Alpha', 'references/one.md')
    expect(readReference).toHaveBeenNthCalledWith(2, 'Alpha', 'references/two.md')
  })

  it('does not expose unexpected filesystem errors through the Chat reference reader', async () => {
    const read = createSkillReferenceReader({
      skillName: 'Alpha',
      readReference: async () => { throw new Error('EACCES: /private/skill/reference.md') },
    })

    await expect(read({ path: 'references/rules.md' })).rejects.toMatchObject({
      code: 'invalid_reference',
      message: 'Unable to read Skill reference',
    })
  })

  it('activates a manually selected Skill before the first model step', async () => {
    const runtime = await createChatSkillRuntime({
      selectedSkillName: 'Alpha',
      baseTools: {},
      ...runtimeDependencies(),
    })

    expect(runtime.snapshot()).toEqual({
      source: 'manual', activeSkillName: 'Alpha', referenceCount: 1, readReferenceCount: 0,
    })
    expect(runtime.catalogContext).toContain('Selected skill: Alpha')
    expect(runtime.catalogContext).toContain('# Alpha rules')
    expect(runtime.catalogContext).toContain('references/rules.md')
    expect(runtime.catalogContext).toContain('Alpha rules')
    expect(runtime.activeContext()).toMatchObject({ skill: { name: 'Alpha' }, activation: 'manual' })
    expect(runtime.capabilityContext?.()?.loadedReferences).toEqual([
      { path: 'references/rules.md', content: 'Alpha rules', bytes: 5 },
    ])
    await expect(runtime.readReferences(['references/rules.md'])).resolves.toEqual([
      { path: 'references/rules.md', content: 'Alpha rules', bytes: 5 },
    ])
    expect(runtime.snapshot().readReferenceCount).toBe(1)
    expect(runtime.capabilityContext?.()?.loadedReferences).toEqual([
      { path: 'references/rules.md', content: 'Alpha rules', bytes: 5 },
    ])
  })

  it('loads at most one automatic Skill and scopes subsequent reference reads', async () => {
    const runtime = await createChatSkillRuntime({ baseTools: {}, ...runtimeDependencies() })

    expect(runtime.catalogContext).toContain('Alpha: Alpha description')
    expect(runtime.catalogContext).not.toContain('# Alpha rules')
    await expect(executeTool(runtime.tools.readSkillReference, { path: 'references/rules.md' }))
      .rejects.toMatchObject({ code: 'not_found' })

    await expect(executeTool(runtime.tools.loadSkill, { name: 'Alpha' })).resolves.toMatchObject({
      name: 'Alpha',
      instructions: '# Alpha rules',
      references: [{ path: 'references/rules.md', bytes: 5 }],
      preloadedReferences: [{ path: 'references/rules.md', content: 'Alpha rules', bytes: 5 }],
    })
    await expect(executeTool(runtime.tools.readSkillReference, { path: 'references/rules.md' })).resolves.toMatchObject({
      path: 'references/rules.md', content: 'Alpha rules',
    })
    await expect(executeTool(runtime.tools.loadSkill, { name: 'Beta' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(runtime.snapshot()).toEqual({
      source: 'automatic', activeSkillName: 'Alpha', referenceCount: 1, readReferenceCount: 1,
    })
  })

  it('restores an automatically activated Skill with its preloaded rules on the next turn', async () => {
    const runtime = await createChatSkillRuntime({
      restoredSkillName: 'Alpha',
      baseTools: {},
      ...runtimeDependencies(),
    })

    expect(runtime.snapshot()).toEqual({
      source: 'restored', activeSkillName: 'Alpha', referenceCount: 1, readReferenceCount: 0,
    })
    expect(runtime.catalogContext).toContain('Active skill restored from this conversation: Alpha')
    expect(runtime.catalogContext).toContain('Preloaded Skill references (already loaded; follow these rules)')
    expect(runtime.catalogContext).toContain('Alpha rules')
    expect(runtime.catalogContext).toContain('Do not claim that this Skill or these references were not loaded')
    expect(runtime.tools.loadSkill).toBeUndefined()
  })

  it('falls back to automatic selection when a previously active Skill is no longer enabled', async () => {
    const runtime = await createChatSkillRuntime({
      restoredSkillName: 'Removed',
      baseTools: {},
      ...runtimeDependencies(),
    })

    expect(runtime.snapshot().activeSkillName).toBeUndefined()
    expect(runtime.catalogContext).toContain('Enabled Skills available for automatic activation')
    expect(runtime.tools.loadSkill).toBeDefined()
  })

  it('accepts a strict image prompt with optional asset title and directory', () => {
    expect(imageGenerationInputSchema.safeParse({ prompt: 'x'.repeat(4_000) }).success).toBe(true)
    expect(imageGenerationInputSchema.safeParse({
      prompt: 'daily ranking chart',
      title: 'GitHub 日榜 2026-08-09',
      directory: '临时文件',
    }).success).toBe(true)
    expect(imageGenerationInputSchema.safeParse({ kind: 'cover', note: 'x' }).success).toBe(false)
    expect(imageGenerationInputSchema.safeParse({ prompt: 'x', directory: '临时文件', extra: true }).success).toBe(false)
  })

  it('delegates generateImage to the direct host generator instead of creating a job', async () => {
    setMcpTools({})
    const imageGenerator = {
      generate: vi.fn().mockResolvedValue({
        asset_id: 100,
        asset_url: '/api/uploads/direct.png',
        title: 'GitHub 日榜',
        directory: '临时文件',
        model: 'gpt-image-1',
      }),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const runtime = await openGlobalAgentTools({
      mcpEndpoint: 'http://localhost:8000/mcp',
      imageGenerator,
      approvalPolicy: 'automatic',
    })

    expect((runtime.tools.generateImage as { description?: string }).description)
      .toContain('临时文件')
    expect((runtime.tools.generateImage as { description?: string }).description)
      .toContain('explicitly requests')
    await expect(executeTool(runtime.tools.generateImage, {
      prompt: 'daily ranking chart',
      title: 'GitHub 日榜',
      directory: '临时文件',
    })).resolves.toMatchObject({ asset_id: 100, asset_url: '/api/uploads/direct.png' })
    expect(imageGenerator.generate).toHaveBeenCalledWith({
      prompt: 'daily ranking chart',
      title: 'GitHub 日榜',
      directory: '临时文件',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    await runtime.close()
  })
})
