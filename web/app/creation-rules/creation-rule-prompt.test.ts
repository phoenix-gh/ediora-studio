// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CreationRuleDialog } from './CreationRuleDialog'
import { buildCreationRulePrompt } from './creation-rule-prompt'

describe('buildCreationRulePrompt', () => {
  it('generates an editable X draft prompt with exact tool arguments', () => {
    const prompt = buildCreationRulePrompt({
      assetType: 'article',
      directories: ['搞钱副业', 'AI 产品'],
      targetCount: 3,
      lookbackDays: 14,
      accountId: null,
      skillMode: 'auto',
      skillName: null,
      instructions: '每句话单独成段',
    })

    expect(prompt).toContain('搞钱副业、AI 产品')
    expect(prompt).toContain('创作 3 条中文 X 短帖')
    expect(prompt).toContain('最近 14 天')
    expect(prompt).toContain('save_draft')
    expect(prompt).toContain('draft_type="x"')
    expect(prompt).toContain('record_content_usage')
    expect(prompt).toContain('save_draft 成功')
    expect(prompt).toContain('每句话单独成段')
    expect(prompt).not.toContain('save_daily_creation_outputs')
  })

  it('uses the selected asset type, account, and manual Skill as Agent context', () => {
    const prompt = buildCreationRulePrompt({
      assetType: 'media',
      directories: ['播客片段'],
      targetCount: 1,
      lookbackDays: 7,
      accountId: 'x-account-42',
      skillMode: 'manual',
      skillName: 'x-article-writing',
      instructions: '',
    })

    expect(prompt).toContain('媒体素材')
    expect(prompt).toContain('x-account-42')
    expect(prompt).toContain('x-article-writing')
    expect(prompt).toContain('自行判断')
    expect(prompt).toContain('record_content_usage')
  })
})

describe('CreationRuleDialog prompt editor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const onceRule = {
    id: 9,
    name: '一次任务',
    prompt: '在指定时间检查一次发布状态。',
    asset_type: 'article' as const,
    directory: '', directories: [],
    output_type: 'x_short_post' as const,
    target_count: 1,
    execution_mode: 'once' as const,
    scheduled_date: '2026-08-12',
    scheduled_time: '09:00',
    timezone: 'Asia/Shanghai',
    lookback_days: 7,
    delivery_mode: 'drafts' as const,
    account_id: null, instructions: '',
    skill_mode: 'auto' as const, skill_name: null,
    enabled: true,
    deleted_at: null,
    last_run_at: null, next_run_at: '2026-08-12T01:00:00Z',
    created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z',
  }

  function renderDialog(initial?: typeof onceRule) {
    const onSubmit = vi.fn()
    render(createElement(CreationRuleDialog, {
      open: true,
      directories: [{ id: 1, name: '产品实验', asset_type: 'article' }],
      skills: [],
      initial,
      onClose: vi.fn(),
      onSubmit,
    }))
    return onSubmit
  }

  it('submits a manual prompt without requiring a directory', () => {
    const onSubmit = renderDialog()

    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '手工任务' } })
    fireEvent.change(screen.getByLabelText('Agent 提示词'), { target: { value: '只写一个可验证的观点。' } })
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: '手工任务',
      prompt: '只写一个可验证的观点。',
      directory: '',
      directories: [],
    }))
  })

  it('fills the editable prompt when the quick generator is requested', () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '生成提示词' }))

    expect((screen.getByLabelText('Agent 提示词') as HTMLTextAreaElement).value).toContain('save_draft')
  })

  it('does not change a manual prompt when builder fields change', () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Agent 提示词'), { target: { value: '保留这条人工提示词。' } })
    fireEvent.change(screen.getByLabelText('目标数量'), { target: { value: '5' } })

    expect(screen.getByLabelText('Agent 提示词')).toHaveValue('保留这条人工提示词。')
  })

  it('confirms before a generator replaces a non-empty prompt', () => {
    renderDialog()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    fireEvent.change(screen.getByLabelText('Agent 提示词'), { target: { value: '不要替换。' } })
    fireEvent.click(screen.getByRole('button', { name: '生成提示词' }))

    expect(confirm).toHaveBeenCalledWith('重新生成会替换当前提示词，是否继续？')
    expect(screen.getByLabelText('Agent 提示词')).toHaveValue('不要替换。')

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '生成提示词' }))

    expect((screen.getByLabelText('Agent 提示词') as HTMLTextAreaElement).value).toContain('创作 3 条中文 X 短帖')
  })

  it('clears the hidden one-time date when switching to recurring', () => {
    const onSubmit = renderDialog(onceRule)

    fireEvent.change(screen.getByLabelText('执行方式'), {
      target: { value: 'recurring' },
    })
    fireEvent.change(screen.getByLabelText('时区'), {
      target: { value: 'Asia/Tokyo' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      execution_mode: 'recurring',
      scheduled_date: null,
      timezone: 'Asia/Tokyo',
    }))
  })

  it('rejects an invalid editable timezone before submission', () => {
    const onSubmit = renderDialog()

    fireEvent.change(screen.getByLabelText('任务名称'), {
      target: { value: '时区任务' },
    })
    fireEvent.change(screen.getByLabelText('Agent 提示词'), {
      target: { value: '执行一个任务。' },
    })
    fireEvent.change(screen.getByLabelText('时区'), {
      target: { value: 'Mars/Olympus' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存规则' }))

    expect(screen.getByRole('alert')).toHaveTextContent('请输入有效时区')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
