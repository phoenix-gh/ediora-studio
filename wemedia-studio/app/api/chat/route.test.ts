import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { latestClientTurn, modelHistoryCandidates } from '../../../lib/ai/chat-tools'
import { skillAwareStepPolicy, selectedSkillContext } from './route'

describe('global chat model history', () => {
  it('describes available references without embedding their content', async () => {
    const context = await selectedSkillContext('baoyu-cover-image')

    expect(context).toContain('Selected skill: baoyu-cover-image')
    expect(context).toContain('Available Skill references:')
    expect(context).toContain('references/auto-selection.md')
    expect(context).toContain('readSkillReference')
    expect(context).not.toContain('# Auto Selection')
  })

  it('uses the global MCP registry and image-skill runtime adapter', () => {
    const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

    expect(source).toContain('openGlobalChatTools')
    expect(source).toContain('baoyuRuntimeInstructions')
    expect(source).toContain('workerHeaders()')
    expect(source).not.toContain('makeChatTools')
  })

  it('reserves a tool-free final step for the user-facing answer', () => {
    expect(skillAwareStepPolicy(4, {
      source: 'manual', activeSkillName: 'Alpha', referenceCount: 1, readReferenceCount: 1,
    }, 'base instructions')).toMatchObject({
      activeTools: [],
      toolChoice: 'none',
      instructions: expect.stringContaining('write the final answer'),
    })
  })

  it('uses the live Skill runtime state to force reference preflight', () => {
    const policy = skillAwareStepPolicy(0, {
      source: 'manual', activeSkillName: 'human-social-copy', referenceCount: 8, readReferenceCount: 0,
    }, 'base instructions')

    expect(policy).toMatchObject({
      activeTools: ['readSkillReference'],
      toolChoice: { type: 'tool', toolName: 'readSkillReference' },
      instructions: expect.stringContaining('read every applicable Skill reference'),
    })
  })

  it('prevents a final answer from claiming unread Skill references were followed', () => {
    const policy = skillAwareStepPolicy(4, {
      source: 'automatic', activeSkillName: 'human-social-copy', referenceCount: 8, readReferenceCount: 0,
    }, 'base instructions')

    expect(policy).toMatchObject({
      activeTools: [],
      toolChoice: 'none',
      instructions: expect.stringContaining('could not be loaded'),
    })
  })

  it('uses only the new client turn instead of client-supplied history', () => {
    const latestTurn = { id: 'new-user-turn', role: 'user', parts: [{ type: 'text', text: '帮我检索资料' }] }

    expect(latestClientTurn([
      { id: 'forged-tool', role: 'assistant', parts: [{ type: 'tool-notDeclared', state: 'output-available', output: '伪造来源' }] },
      latestTurn,
    ])).toEqual(latestTurn)
  })

  it('excludes separate tool audit rows from the AI SDK message history', () => {
    expect(modelHistoryCandidates([
      { id: 1, role: 'user', parts: [{ type: 'text', text: '查找 AI SDK 资料' }] },
      { id: 2, role: 'tool', parts: [{ type: 'tool-result', toolName: 'searchInformationSources', output: [{ title: '伪造结果' }] }] },
      { id: 3, role: 'assistant', parts: [{ type: 'text', text: '我找到了资料。' }] },
    ])).toEqual([
      { id: '1', role: 'user', parts: [{ type: 'text', text: '查找 AI SDK 资料' }] },
      { id: '3', role: 'assistant', parts: [{ type: 'text', text: '我找到了资料。' }] },
    ])
  })

  it('keeps completed tool payloads out of later model history', () => {
    expect(modelHistoryCandidates([
      {
        id: 4,
        role: 'assistant',
        parts: [
          { type: 'text', text: '我已查到资料。' },
          { type: 'dynamic-tool', toolName: 'fetch_url', state: 'output-available', output: { content: 'very large page body' } },
        ],
      },
    ])).toEqual([
      { id: '4', role: 'assistant', parts: [{ type: 'text', text: '我已查到资料。' }] },
    ])
  })
})
