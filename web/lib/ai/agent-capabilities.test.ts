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
