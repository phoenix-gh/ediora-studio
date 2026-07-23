import { describe, expect, it } from 'vitest'

import { baoyuRuntimeInstructions, coverConstraintsFromStyle, extractBaoyuSkillCore, imageToolNamesForSkill, parseDailyPlanText, textModelForProvider, toolsForContentStep } from './content-job'

describe('content job tool allowlist', () => {
  it('limits draft orchestration to declared tools', () => {
    expect(toolsForContentStep('draft')).toEqual([
      'getBrief',
      'loadWritingContext',
      'saveDraft',
    ])
  })
})

describe('Baoyu image skills', () => {
  it('exposes one controlled image-generation tool to both image skills', () => {
    expect(imageToolNamesForSkill('cover')).toEqual(['generateImage'])
    expect(imageToolNamesForSkill('illustrations')).toEqual(['generateImage'])
  })

  it('adapts vendored skills to the non-interactive application runtime', () => {
    const cover = baoyuRuntimeInstructions('cover', 1)

    expect(cover).toContain('five dimensions')
    expect(cover).toContain('generateImage exactly 1 time')
    expect(cover).not.toContain('First-Time Setup')
    expect(cover).not.toContain('AskUserQuestion')
  })

  it('uses the safe core rules from the vendored cover skill', () => {
    const core = extractBaoyuSkillCore('cover', `intro\n## Five Dimensions\ncover-rule\n## File Structure\ninteractive-workflow`)

    expect(core).toContain('cover-rule')
    expect(core).not.toContain('interactive-workflow')
  })

  it('turns account cover style into non-negotiable image constraints', () => {
    expect(coverConstraintsFromStyle({
      type: 'scene', palette: 'vivid', rendering: 'hand-drawn', text: 'text-rich', mood: 'bold', aspect_ratio: '16:9',
      signature_motifs: ['MK@Phoenix tag ribbon'], negative: ['no dark background'],
    })).toContain('MUST use type: scene')
    expect(coverConstraintsFromStyle({ signature_motifs: ['MK@Phoenix tag ribbon'] })).toContain('MUST include: MK@Phoenix tag ribbon')
    expect(coverConstraintsFromStyle({ negative: ['no dark background'] })).toContain('MUST NOT include: no dark background')
  })
})

describe('compatible OpenAI providers', () => {
  it('uses Chat Completions models for text generation', () => {
    const provider = { chat: (modelName: string) => ({ endpoint: 'chat', modelName }) }

    expect(textModelForProvider(provider, 'deepseek-v4-flash')).toEqual({
      endpoint: 'chat',
      modelName: 'deepseek-v4-flash',
    })
  })
})

describe('daily-plan compatible output', () => {
  it('validates plain JSON returned by a compatible Chat Completions model', () => {
    expect(parseDailyPlanText('{"note":"今日重点","items":[{"account_id":"mp_qdgzs","title":"AI SDK 入门","angle":"从接口兼容性切入","reason":"适合今日主题","content_type":"long"}]}')).toEqual({
      note: '今日重点',
      items: [{
        account_id: 'mp_qdgzs', title: 'AI SDK 入门', angle: '从接口兼容性切入', reason: '适合今日主题',
        content_type: 'long', sources: [], group_key: '', is_primary: true,
      }],
    })
  })

  it('normalizes string sources to source objects', () => {
    expect(parseDailyPlanText('{"note":"今日重点","items":[{"account_id":"mp_qdgzs","title":"AI SDK 入门","angle":"接口兼容性","reason":"适合今日主题","content_type":"long","sources":["https://example.com/source"]}]}').items[0].sources).toEqual([
      { url: 'https://example.com/source' },
    ])
  })
})
