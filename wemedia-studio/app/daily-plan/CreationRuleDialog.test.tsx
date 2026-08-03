// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { CreationRuleDialog } from './CreationRuleDialog'

it('submits a bounded recurring rule with multiple selected asset directories', () => {
  const onSubmit = vi.fn()
  render(<CreationRuleDialog open directories={[
    { id: 1, name: '产品实验', asset_type: 'article' },
    { id: 2, name: '增长资料', asset_type: 'article' },
  ]} accounts={[]} skills={[]} onClose={() => {}} onSubmit={onSubmit} />)

  fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '产品短帖' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '产品实验' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '增长资料' }))
  fireEvent.change(screen.getByLabelText('目标数量'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('去重天数'), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    name: '产品短帖', directory: '产品实验', directories: ['产品实验', '增长资料'], target_count: 10,
    lookback_days: 7, execution_mode: 'recurring',
    output_type: 'x_short_post', delivery_mode: 'drafts',
  }))
})

it('shows accessible validation and requires a date for a one-time rule', () => {
  render(<CreationRuleDialog open directories={[]} accounts={[]} skills={[]} onClose={() => {}} onSubmit={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('执行方式'), { target: { value: 'once' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(screen.getByRole('alert')).toHaveTextContent('请选择至少一个素材目录')
  expect(screen.getByLabelText('执行日期')).toBeRequired()
})

it('filters directories by asset type and requires an account for plan delivery', () => {
  const onSubmit = vi.fn()
  render(<CreationRuleDialog open directories={[
    { id: 1, name: '文章库', asset_type: 'article' },
    { id: 2, name: '媒体库', asset_type: 'media' },
  ]} accounts={[{ id: 'writer', name: '主账号' }]} skills={[]} onClose={() => {}} onSubmit={onSubmit} />)

  expect(screen.getByRole('checkbox', { name: '文章库' })).toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: '媒体库' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox', { name: '文章库' }))
  fireEvent.change(screen.getByLabelText('素材类型'), { target: { value: 'media' } })
  expect(screen.getByRole('checkbox', { name: '媒体库' })).not.toBeChecked()
  fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '媒体短帖' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '媒体库' }))
  fireEvent.change(screen.getByLabelText('产出位置'), { target: { value: 'plan_items' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(screen.getByRole('alert')).toHaveTextContent('请选择发布账号')
  fireEvent.change(screen.getByLabelText('发布账号'), { target: { value: 'writer' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    asset_type: 'media', directory: '媒体库', directories: ['媒体库'], delivery_mode: 'plan_items', account_id: 'writer',
  }))
})

it('defaults to automatic Skill matching and submits one manual Skill', () => {
  const onSubmit = vi.fn()
  render(<CreationRuleDialog open directories={[
    { id: 1, name: '产品实验', asset_type: 'article' },
  ]} accounts={[]} skills={[
    { name: 'human-social-copy', description: '中文社媒写作', version: '1.0.0' },
  ]} onClose={() => {}} onSubmit={onSubmit} />)

  expect(screen.getByRole('radio', { name: '自动匹配' })).toBeChecked()
  fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '搞钱短帖' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '产品实验' }))
  fireEvent.click(screen.getByRole('radio', { name: '手动指定' }))
  fireEvent.change(screen.getByLabelText('指定 Skill'), {
    target: { value: 'human-social-copy' },
  })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    skill_mode: 'manual', skill_name: 'human-social-copy',
  }))
})

it('keeps an unavailable saved manual Skill visible while editing', () => {
  render(<CreationRuleDialog open directories={[
    { id: 1, name: '产品实验', asset_type: 'article' },
  ]} accounts={[]} skills={[]} initial={{
    id: 7, name: '历史规则', asset_type: 'article', directory: '产品实验', directories: ['产品实验'],
    output_type: 'x_short_post', target_count: 3, execution_mode: 'recurring',
    scheduled_date: null, scheduled_time: '09:00', timezone: 'Asia/Shanghai',
    lookback_days: 7, delivery_mode: 'drafts', account_id: null, instructions: '',
    skill_mode: 'manual', skill_name: 'human-social-copy', enabled: true,
    created_at: '', updated_at: '',
  }} onClose={() => {}} onSubmit={vi.fn()} />)

  expect(screen.getByRole('option', { name: 'human-social-copy（不可用）' })).toBeInTheDocument()
})
