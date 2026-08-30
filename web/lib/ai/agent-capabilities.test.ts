import type { ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  buildAgentCapabilitySnapshot,
  buildToolCapabilityDescriptors,
  capabilitySnapshotDrift,
  pinCapabilitySnapshot,
  sha256Text,
} from './agent-capabilities'
import type { RegisteredSkill } from '../skills/registry'
import type { ToolContract } from './tool-contract'

const uploadedSkill: RegisteredSkill = {
  name: 'Alpha',
  description: 'Alpha workflow',
  version: '1.2.3',
  digest: 'a'.repeat(64),
  source: 'uploaded',
  enabled: true,
  reviewState: 'approved',
  standardCompatible: true,
  diagnostics: [],
  instructions: '# Alpha rules\nUse evidence.',
  content: '# Alpha rules\nUse evidence.',
  directory: '/skills/alpha',
  packageFiles: [],
  requestedAllowedTools: [],
}

const baseSnapshot = {
  schemaVersion: 1 as const,
  mode: 'job' as const,
  skill: {
    name: 'Alpha',
    version: '1.2.3',
    source: 'uploaded' as const,
    activation: 'automatic' as const,
    instructionsDigest: 'a'.repeat(64),
    references: [{
      path: 'rules.md', bytes: 10, loaded: true, contentDigest: 'b'.repeat(64),
    }],
  },
  tools: [{
    name: 'save_draft', description: 'Save', inputSchemaDigest: null,
    sideEffecting: true, needsApproval: false,
    replayPolicy: 'uncertain-on-interruption' as const,
    concurrencyPolicy: 'serialized' as const,
    idempotencyPolicy: 'claim-backed' as const,
  }],
  policy: { approvalPolicy: 'automatic' as const, allowedToolNames: null },
}

const getDraftContract: ToolContract = {
  name: 'get_draft',
  namespace: 'drafts',
  version: '1',
  description: 'Read one full draft by known ID.',
  inputSchema: { type: 'object', properties: { draft_id: { type: 'integer' } } },
  outputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    approval: 'never',
  },
  execution: { concurrency: 'parallel-safe', retry: 'safe' },
  availability: 'available',
  contractDigest: 'c'.repeat(64),
  source: 'mcp',
}

describe('Agent capability snapshots', () => {
  it('sorts references and tools while omitting content bodies', () => {
    const snapshot = buildAgentCapabilitySnapshot({
      mode: 'job',
      skill: {
        skill: uploadedSkill,
        activation: 'automatic',
        references: [
          { path: 'z.md', bytes: 4 },
          { path: 'a.md', bytes: 3 },
        ],
        loadedReferences: [{ path: 'z.md', bytes: 4, content: 'secret rules' }],
      },
      tools: {
        update_draft: {
          description: 'Update',
          inputSchema: { type: 'object' },
          needsApproval: true,
        },
        search_drafts: {
          description: 'Search',
          inputSchema: { type: 'object' },
          needsApproval: false,
        },
      } as unknown as ToolSet,
      approvalPolicy: 'automatic',
      allowedToolNames: ['update_draft', 'search_drafts'],
    })

    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.mode).toBe('job')
    expect(snapshot.tools.map(tool => tool.name)).toEqual(['search_drafts', 'update_draft'])
    expect(snapshot.skill?.references).toEqual([
      expect.objectContaining({ path: 'a.md', loaded: false, contentDigest: null }),
      expect.objectContaining({ path: 'z.md', loaded: true }),
    ])
    expect(snapshot.skill?.instructionsDigest).toBe(sha256Text(uploadedSkill.instructions))
    expect(snapshot.policy).toEqual({
      approvalPolicy: 'automatic',
      allowedToolNames: ['search_drafts', 'update_draft'],
    })
    expect(JSON.stringify(snapshot)).not.toContain('secret rules')
  })

  it('marks current side-effecting tools as uncertain on interruption', () => {
    const descriptors = buildToolCapabilityDescriptors({
      update_draft: {
        description: 'Update',
        inputSchema: { type: 'object' },
        needsApproval: true,
      },
      search_drafts: {
        description: 'Search',
        inputSchema: { type: 'object' },
        needsApproval: false,
      },
    } as unknown as ToolSet)

    expect(descriptors).toEqual([
      expect.objectContaining({
        name: 'search_drafts',
        sideEffecting: false,
        needsApproval: false,
        replayPolicy: 'replayable',
        concurrencyPolicy: 'parallel-safe',
        idempotencyPolicy: 'replayable',
      }),
      expect.objectContaining({
        name: 'update_draft',
        sideEffecting: true,
        needsApproval: true,
        replayPolicy: 'uncertain-on-interruption',
        concurrencyPolicy: 'serialized',
        idempotencyPolicy: 'claim-backed',
      }),
    ])
  })

  it('records normalized Tool Contract identity and schema evidence', () => {
    const snapshot = buildAgentCapabilitySnapshot({
      mode: 'chat',
      tools: {
        get_draft: {
          description: getDraftContract.description,
          inputSchema: getDraftContract.inputSchema,
          outputSchema: getDraftContract.outputSchema,
          needsApproval: false,
        },
      } as unknown as ToolSet,
      contracts: new Map([['get_draft', getDraftContract]]),
      approvalPolicy: 'interactive',
    })

    expect(snapshot.tools[0]).toMatchObject({
      name: 'get_draft',
      namespace: 'drafts',
      version: '1',
      contractDigest: 'c'.repeat(64),
      availability: 'available',
      outputSchemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sideEffecting: false,
      replayPolicy: 'replayable',
    })
  })

  it('records null when a Tool schema cannot be serialized stably', () => {
    const descriptors = buildToolCapabilityDescriptors({
      opaque: {
        description: 'Opaque schema',
        inputSchema: { parse: () => undefined },
        needsApproval: false,
      },
    } as unknown as ToolSet)

    expect(descriptors).toEqual([expect.objectContaining({
      name: 'opaque',
      inputSchemaDigest: null,
    })])
  })

  it('ignores activation changes but detects Tool and Skill capability drift', () => {
    expect(capabilitySnapshotDrift(baseSnapshot, {
      ...baseSnapshot,
      skill: { ...baseSnapshot.skill, activation: 'restored' },
    })).toBeUndefined()
    expect(capabilitySnapshotDrift(baseSnapshot, {
      ...baseSnapshot,
      tools: [],
    })).toBe('tools')
    expect(capabilitySnapshotDrift(baseSnapshot, {
      ...baseSnapshot,
      skill: { ...baseSnapshot.skill, instructionsDigest: 'c'.repeat(64) },
    })).toBe('skill')
  })

  it('keeps legacy snapshots compatible while comparing metadata when both sides have it', () => {
    const legacyTool = Object.fromEntries(
      Object.entries(baseSnapshot.tools[0]).filter(([key]) => (
        key !== 'concurrencyPolicy' && key !== 'idempotencyPolicy'
      )),
    )
    expect(capabilitySnapshotDrift(baseSnapshot, {
      ...baseSnapshot,
      tools: [legacyTool],
    } as typeof baseSnapshot)).toBeUndefined()
    expect(capabilitySnapshotDrift(baseSnapshot, {
      ...baseSnapshot,
      tools: [{
        ...baseSnapshot.tools[0], idempotencyPolicy: 'unknown' as const,
      }],
    })).toBe('tools')
  })

  it('keeps old schema-version-1 snapshots compatible while detecting new contract drift', () => {
    const oldSnapshot = baseSnapshot
    const newTool = {
      ...baseSnapshot.tools[0],
      namespace: 'drafts' as const,
      version: '1',
      outputSchemaDigest: 'd'.repeat(64),
      contractDigest: 'e'.repeat(64),
      availability: 'available' as const,
    }
    const current = { ...baseSnapshot, tools: [newTool] }

    expect(capabilitySnapshotDrift(oldSnapshot, current)).toBeUndefined()
    expect(pinCapabilitySnapshot(oldSnapshot, current)).toBe(oldSnapshot)
    expect(capabilitySnapshotDrift(current, {
      ...current,
      tools: [{ ...newTool, contractDigest: 'f'.repeat(64) }],
    })).toBe('tools')
    expect(capabilitySnapshotDrift(current, { ...current, tools: [{ ...newTool }] }))
      .toBeUndefined()
  })

  it('allows the first run to pin a Skill after the prepared baseline', () => {
    const current = {
      ...baseSnapshot,
      skill: { ...baseSnapshot.skill, activation: 'automatic' as const },
    }
    expect(pinCapabilitySnapshot({ ...baseSnapshot, skill: null }, current, {
      allowSkillBootstrap: true,
    })).toEqual(current)
    expect(() => pinCapabilitySnapshot({ ...baseSnapshot, skill: null }, current))
      .toThrow('Agent capability drift detected: skill')
  })
})
