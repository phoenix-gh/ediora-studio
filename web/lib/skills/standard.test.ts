import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { inspectSkillPackage, parseSkillDocument } from './standard'

const valid = `---
name: source-research
description: Researches attributable sources when a user needs evidence.
metadata:
  version: "1.2.0"
  ediora-display-name: "资料研究"
allowed-tools: search fetch
---

# Workflow

Research first.
`

describe('standard Agent Skill document', () => {
  it('normalizes standard frontmatter and keeps allowed-tools non-authoritative', () => {
    const parsed = parseSkillDocument(valid, {
      expectedDirectoryName: 'source-research',
      allowLegacy: false,
    })

    expect(parsed).toMatchObject({
      name: 'source-research',
      version: '1.2.0',
      metadata: {
        version: '1.2.0',
        'ediora-display-name': '资料研究',
      },
      requestedAllowedTools: ['search', 'fetch'],
      body: expect.stringContaining('# Workflow'),
      standardCompatible: true,
    })
  })

  it.each([
    'Uppercase',
    '-leading',
    'trailing-',
    'double--hyphen',
    'a'.repeat(65),
  ])('rejects invalid standard name %s', name => {
    const document = valid.replace('source-research', name)
    expect(() => parseSkillDocument(document, {
      expectedDirectoryName: name,
      allowLegacy: false,
    })).toThrow(/name/i)
  })

  it('rejects an empty description and a parent-directory mismatch', () => {
    expect(() => parseSkillDocument(
      valid.replace(
        'description: Researches attributable sources when a user needs evidence.',
        'description: ""',
      ),
      { expectedDirectoryName: 'source-research', allowLegacy: false },
    )).toThrow(/description/i)

    expect(() => parseSkillDocument(valid, {
      expectedDirectoryName: 'different-name',
      allowLegacy: false,
    })).toThrow(/directory/i)
  })

  it('keeps a discoverable legacy name only in compatibility mode', () => {
    const legacy = valid.replace('source-research', 'Legacy_Name')
    const parsed = parseSkillDocument(legacy, { allowLegacy: true })
    expect(parsed.standardCompatible).toBe(false)
    expect(parsed.diagnostics).toContain('legacy_name')
    expect(() => parseSkillDocument(legacy, { allowLegacy: false })).toThrow()
  })

  it('fingerprints all regular package files and classifies resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ediora-standard-skill-'))
    try {
      await mkdir(join(root, 'references'))
      await mkdir(join(root, 'scripts'))
      await writeFile(join(root, 'SKILL.md'), valid)
      await writeFile(join(root, 'references', 'rules.md'), 'rules')
      await writeFile(join(root, 'scripts', 'collect.py'), 'print("no execution")')

      const first = await inspectSkillPackage(root)
      await writeFile(join(root, 'references', 'rules.md'), 'changed rules')
      const second = await inspectSkillPackage(root)

      expect(first.files).toEqual(expect.arrayContaining([
        { path: 'references/rules.md', bytes: 5, kind: 'reference' },
        { path: 'scripts/collect.py', bytes: 21, kind: 'script' },
      ]))
      expect(second.digest).not.toBe(first.digest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
