import type { ListToolsResult } from '@ai-sdk/mcp'
import type { ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'

import { buildToolRegistry, contractsForTools, registryContractRecord } from './tool-registry'
import type { ToolContractMetadata } from './tool-contract'


function executable(description = 'Read stored items.') {
  return {
    description,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => [],
  } as unknown as ToolSet[string]
}

function definition(name: string): ListToolsResult['tools'][number] {
  return {
    name,
    description: `Read ${name} from stored information sources.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'dev.ediora/tool': {
        namespace: 'information_sources',
        version: '1',
        approval: 'never',
        concurrency: 'parallel-safe',
        retry: 'safe',
      },
    },
  }
}

const nativeMetadata: ToolContractMetadata = {
  namespace: 'skills',
  version: '1',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
  approval: 'never',
  concurrency: 'parallel-safe',
  retry: 'safe',
}

describe('Tool Registry', () => {
  it('pairs one MCP definition with its executable', () => {
    const registry = buildToolRegistry({
      tools: { list_items: executable() } as ToolSet,
      mcpDefinitions: [definition('list_items')],
    })

    expect(Object.keys(registry.tools)).toEqual(['list_items'])
    expect(registry.contracts.get('list_items')).toMatchObject({
      namespace: 'information_sources',
      source: 'mcp',
    })
    expect(registry.get('list_items')).toEqual({
      tool: registry.tools.list_items,
      contract: registry.contracts.get('list_items'),
    })
    expect(registry.diagnostics).toEqual([])
  })

  it('registers an explicitly contracted native tool', () => {
    const registry = buildToolRegistry({
      tools: { readSkillReference: executable('Read one Skill reference.') } as ToolSet,
      nativeContracts: { readSkillReference: nativeMetadata },
    })

    expect(registry.contracts.get('readSkillReference')).toMatchObject({
      namespace: 'skills',
      source: 'native',
    })
  })

  it('does not reintroduce a tool removed from definitions and executables', () => {
    const registry = buildToolRegistry({ tools: {}, mcpDefinitions: [] })

    expect(registry.get('upload_image_from_url')).toBeUndefined()
    expect(registry.contracts.has('upload_image_from_url')).toBe(false)
  })

  it('rejects duplicate MCP definitions and MCP/native name collisions', () => {
    const duplicateDefinitions = buildToolRegistry({
      tools: { list_items: executable() } as ToolSet,
      mcpDefinitions: [definition('list_items'), definition('list_items')],
    })
    const crossSourceDuplicate = buildToolRegistry({
      tools: { list_items: executable() } as ToolSet,
      mcpDefinitions: [definition('list_items')],
      nativeContracts: { list_items: nativeMetadata },
    })

    expect(duplicateDefinitions.get('list_items')).toBeUndefined()
    expect(duplicateDefinitions.diagnostics).toEqual([
      expect.objectContaining({ toolName: 'list_items', code: 'duplicate-tool' }),
    ])
    expect(crossSourceDuplicate.get('list_items')).toBeUndefined()
    expect(crossSourceDuplicate.diagnostics).toEqual([
      expect.objectContaining({ toolName: 'list_items', code: 'duplicate-tool' }),
    ])
  })

  it('admits missing contracts only in compatibility mode', () => {
    const strict = buildToolRegistry({
      tools: { save_legacy_record: executable('Save one legacy record.') } as ToolSet,
    })
    const compatible = buildToolRegistry({
      tools: { save_legacy_record: executable('Save one legacy record.') } as ToolSet,
      compatibilityMode: true,
    })

    expect(strict.get('save_legacy_record')).toBeUndefined()
    expect(strict.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid-contract', severity: 'error' }),
    ])
    expect(compatible.get('save_legacy_record')?.contract.source).toBe('legacy')
    expect(compatible.diagnostics).toEqual([
      expect.objectContaining({ code: 'legacy-contract', severity: 'warning' }),
    ])
  })

  it('excludes invalid definitions and definitions without executables', () => {
    const invalid = { ...definition('bad_tool'), description: undefined }
    const registry = buildToolRegistry({
      tools: { bad_tool: executable() } as ToolSet,
      mcpDefinitions: [invalid, definition('missing_tool')],
    })

    expect(registry.get('bad_tool')).toBeUndefined()
    expect(registry.get('missing_tool')).toBeUndefined()
    expect(registry.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'bad_tool', code: 'invalid-contract' }),
      expect.objectContaining({ toolName: 'missing_tool', code: 'missing-executable' }),
    ]))
  })

  it('sorts entries and diagnostics and filters contract views deterministically', () => {
    const registry = buildToolRegistry({
      tools: {
        z_legacy: executable('Z legacy.'),
        b_items: executable(),
        a_items: executable(),
      } as ToolSet,
      mcpDefinitions: [definition('b_items'), definition('a_items')],
    })

    expect(Object.keys(registry.tools)).toEqual(['a_items', 'b_items'])
    expect([...registry.contracts.keys()]).toEqual(['a_items', 'b_items'])
    expect(registry.diagnostics.map(item => item.toolName)).toEqual(['z_legacy'])
    expect([...contractsForTools(registry, ['b_items']).keys()]).toEqual(['b_items'])
    expect(Object.keys(registryContractRecord(registry))).toEqual(['a_items', 'b_items'])
  })
})
