import type { ListToolsResult } from '@ai-sdk/mcp'
import { tool, type ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  legacyToolContract,
  normalizeMcpToolContract,
  normalizeNativeToolContract,
  type ToolContractMetadata,
} from './tool-contract'


const definition = {
  name: 'get_draft',
  description: 'Read one full draft by known ID.',
  inputSchema: {
    type: 'object' as const,
    properties: { draft_id: { type: 'integer' } },
    required: ['draft_id'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: { id: { type: 'integer' } },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    'dev.ediora/tool': {
      namespace: 'drafts',
      version: '1',
      approval: 'never',
      concurrency: 'parallel-safe',
      retry: 'safe',
    },
  },
} as ListToolsResult['tools'][number]

const nativeTool = {
  description: 'Generate and persist one image.',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { asset_id: { type: 'integer' } } },
  execute: async () => ({ asset_id: 1 }),
} as unknown as ToolSet[string]

const nativeMetadata: ToolContractMetadata = {
  namespace: 'image_generation',
  version: '1',
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: true,
  approval: 'never',
  concurrency: 'serialized',
  retry: 'unsafe',
}

describe('Tool Contract normalization', () => {
  it('preserves MCP schemas and emits a canonical contract', () => {
    const result = normalizeMcpToolContract(definition)

    expect(result.diagnostics).toEqual([])
    expect(result.contract).toMatchObject({
      name: 'get_draft',
      namespace: 'drafts',
      version: '1',
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      availability: 'available',
      source: 'mcp',
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
        approval: 'never',
      },
      execution: { concurrency: 'parallel-safe', retry: 'safe' },
    })
    expect(result.contract?.contractDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces the same digest when JSON object keys are reordered', () => {
    const reordered = {
      ...definition,
      inputSchema: {
        required: ['draft_id'],
        properties: { draft_id: { type: 'integer' } },
        type: 'object' as const,
      },
      _meta: {
        'dev.ediora/tool': {
          retry: 'safe',
          concurrency: 'parallel-safe',
          approval: 'never',
          version: '1',
          namespace: 'drafts',
        },
      },
    } as ListToolsResult['tools'][number]

    expect(normalizeMcpToolContract(reordered).contract?.contractDigest)
      .toBe(normalizeMcpToolContract(definition).contract?.contractDigest)
  })

  it.each([
    [{ ...definition, description: undefined }, 'description'],
    [{
      ...definition,
      _meta: {
        'dev.ediora/tool': {
          ...(definition._meta!['dev.ediora/tool'] as Record<string, unknown>),
          namespace: 'unknown',
        },
      },
    }, 'namespace'],
    [{
      ...definition,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, 'annotations'],
    [{
      ...definition,
      _meta: {
        'dev.ediora/tool': {
          ...(definition._meta!['dev.ediora/tool'] as Record<string, unknown>),
          approval: 'writes',
        },
      },
    }, 'read-only'],
  ])('rejects invalid MCP contract metadata mentioning %s', (candidate, expectedMessage) => {
    const result = normalizeMcpToolContract(candidate as ListToolsResult['tools'][number])

    expect(result.contract).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'invalid-contract' }),
    ])
    expect(result.diagnostics[0]?.message.toLowerCase()).toContain(expectedMessage)
  })

  it('normalizes an explicitly described native tool', () => {
    const result = normalizeNativeToolContract('generateImage', nativeTool, nativeMetadata)

    expect(result.diagnostics).toEqual([])
    expect(result.contract).toMatchObject({
      name: 'generateImage',
      namespace: 'image_generation',
      source: 'native',
      annotations: { readOnly: false, approval: 'never' },
      execution: { concurrency: 'serialized', retry: 'unsafe' },
    })
  })

  it('digests the Zod input schema retained by an AI SDK native tool', () => {
    const sdkTool = tool({
      description: 'Read one named Skill reference.',
      inputSchema: z.object({ path: z.string().min(1) }).strict(),
      execute: async ({ path }) => ({ path }),
    })

    const result = normalizeNativeToolContract('readSkillReference', sdkTool, {
      namespace: 'skills',
      version: '1',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      approval: 'never',
      concurrency: 'parallel-safe',
      retry: 'safe',
    })

    expect(result.diagnostics).toEqual([])
    expect(result.contract?.contractDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('uses a conservative warning-producing contract for legacy writes', () => {
    const result = legacyToolContract('save_legacy_record', nativeTool)

    expect(result.contract).toMatchObject({
      namespace: 'system',
      source: 'legacy',
      annotations: { readOnly: false, approval: 'writes' },
      execution: { concurrency: 'serialized', retry: 'claim-backed' },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'legacy-contract' }),
    ])
  })
})
