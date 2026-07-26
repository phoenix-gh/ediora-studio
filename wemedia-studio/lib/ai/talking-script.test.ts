import { describe, expect, it } from 'vitest'

import {
  buildTalkingScriptPrompt,
  cleanTalkingScript,
  talkingScriptRequestSchema,
} from './talking-script'


describe('talking-script prompt', () => {
  it('converts a draft without changing facts or retaining markdown', () => {
    const prompt = buildTalkingScriptPrompt(
      { mode: 'convert_draft', draftId: 7 },
      {
        title: 'AI 工作流',
        content: '# 标题\n[链接](https://example.com)\n事实正文',
      },
    )

    expect(prompt).toContain('保留原文事实')
    expect(prompt).toContain('自然口语')
    expect(prompt).toContain('事实正文')
    expect(prompt).toContain('不要输出 Markdown')
  })

  it('strips markdown fences and links from the model result', () => {
    expect(
      cleanTalkingScript('```markdown\n大家好，[查看资料](https://example.com)。\n```'),
    ).toBe('大家好，查看资料。')
  })

  it('requires rewrite instructions', () => {
    expect(talkingScriptRequestSchema.safeParse({
      mode: 'rewrite',
      script: '原脚本',
      instructions: '',
    }).success).toBe(false)
  })
})
