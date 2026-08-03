import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mcp = vi.hoisted(() => ({
  tools: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async () => ({ tools: mcp.tools, close: mcp.close })),
}))

import {
  createChatSkillRuntime,
  createImageJob,
  createSkillReferenceReader,
  imageGenerationInputSchema,
  openGlobalAgentTools,
  requiresToolApproval,
} from './global-chat-tools'
import type { AgentToolAudit } from './agent-runtime-types'

const alpha = {
  name: 'Alpha', description: 'Alpha description', version: '1.0.0', source: 'builtin' as const,
  enabled: true, instructions: '# Alpha rules', directory: '/skills/alpha',
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

describe('global Chat tool policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mcp.tools.mockReset()
    mcp.close.mockReset()
  })

  it('requires approval for MCP tools with a sensitive action verb', () => {
    expect(requiresToolApproval('update_draft')).toBe(true)
    expect(requiresToolApproval('upload_image_from_url')).toBe(true)
    expect(requiresToolApproval('search_ref_materials')).toBe(false)
    expect(requiresToolApproval('list_publish_accounts')).toBe(false)
  })

  it('does not require approval to create a durable image-generation job', () => {
    expect(requiresToolApproval('generateImage')).toBe(false)
    expect(requiresToolApproval('readSkillReference')).toBe(false)
  })

  it('opens one automatic global catalog with sensitive tools auto-approved and audited', async () => {
    const audits: AgentToolAudit[] = []
    mcp.tools.mockResolvedValue({
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
      apiBase: 'http://localhost:8000/api',
      approvalPolicy: 'automatic',
      onToolAudit: event => { audits.push(event) },
    })
    const save = runtime.tools.save_item as {
      needsApproval?: boolean
      execute(input: unknown, options: { toolCallId: string }): Promise<unknown>
    }

    expect(save.needsApproval).toBe(false)
    await expect(save.execute({ value: 'shared' }, { toolCallId: 'call-global' }))
      .resolves.toEqual({ id: 9, value: 'shared' })
    expect(audits.at(-1)).toMatchObject({
      toolName: 'save_item', autoApproved: true, status: 'succeeded',
    })
    await runtime.close()
    expect(mcp.close).toHaveBeenCalledOnce()
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
    await expect(runtime.readReferences(['references/rules.md'])).resolves.toEqual([
      { path: 'references/rules.md', content: 'Alpha rules', bytes: 5 },
    ])
    expect(runtime.snapshot().readReferenceCount).toBe(1)
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

  it('accepts only a free-form image prompt', () => {
    expect(imageGenerationInputSchema.safeParse({ prompt: 'x'.repeat(4_000) }).success).toBe(true)
    expect(imageGenerationInputSchema.safeParse({ kind: 'cover', note: 'x' }).success).toBe(false)
  })

  it('creates an independent image job without a draft or image category', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 51, flow: 'standalone_image', status: 'queued' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createImageJob({ apiBase: 'http://localhost:8000/api', prompt: 'minimal editorial cover' }))
      .resolves.toEqual({ jobId: 51, flow: 'standalone_image', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/api/jobs', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"prompt":"minimal editorial cover"'),
    }))
  })

  it('uses the same independent image job for every prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 52, flow: 'standalone_image', status: 'queued' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createImageJob({ apiBase: 'http://localhost:8000/api', prompt: '一张极简风格的月球基地插画' }))
      .resolves.toEqual({ jobId: 52, flow: 'standalone_image', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/api/jobs', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"prompt":"一张极简风格的月球基地插画"'),
    }))
  })
})
