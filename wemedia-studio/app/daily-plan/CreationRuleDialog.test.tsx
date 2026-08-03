// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { CreationRuleDialog } from './CreationRuleDialog'

it('submits a bounded recurring rule with the selected asset directory', () => {
  const onSubmit = vi.fn()
  render(<CreationRuleDialog open directories={[{ id: 1, name: '产品实验', asset_type: 'article' }]} accounts={[]} onClose={() => {}} onSubmit={onSubmit} />)

  fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '产品短帖' } })
  fireEvent.change(screen.getByLabelText('素材目录'), { target: { value: '产品实验' } })
  fireEvent.change(screen.getByLabelText('目标数量'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('去重天数'), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    name: '产品短帖', directory: '产品实验', target_count: 10,
    lookback_days: 7, execution_mode: 'recurring',
    output_type: 'x_short_post', delivery_mode: 'drafts',
  }))
})

it('shows accessible validation and requires a date for a one-time rule', () => {
  render(<CreationRuleDialog open directories={[]} accounts={[]} onClose={() => {}} onSubmit={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('执行方式'), { target: { value: 'once' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(screen.getByRole('alert')).toHaveTextContent('请选择素材目录')
  expect(screen.getByLabelText('执行日期')).toBeRequired()
})

it('filters directories by asset type and requires an account for plan delivery', () => {
  const onSubmit = vi.fn()
  render(<CreationRuleDialog open directories={[
    { id: 1, name: '文章库', asset_type: 'article' },
    { id: 2, name: '媒体库', asset_type: 'media' },
  ]} accounts={[{ id: 'writer', name: '主账号' }]} onClose={() => {}} onSubmit={onSubmit} />)

  expect(screen.getByLabelText('素材目录')).toHaveTextContent('文章库')
  expect(screen.getByLabelText('素材目录')).not.toHaveTextContent('媒体库')
  fireEvent.change(screen.getByLabelText('素材类型'), { target: { value: 'media' } })
  expect(screen.getByLabelText('素材目录')).toHaveTextContent('媒体库')
  fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '媒体短帖' } })
  fireEvent.change(screen.getByLabelText('素材目录'), { target: { value: '媒体库' } })
  fireEvent.change(screen.getByLabelText('产出位置'), { target: { value: 'plan_items' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(screen.getByRole('alert')).toHaveTextContent('请选择发布账号')
  fireEvent.change(screen.getByLabelText('发布账号'), { target: { value: 'writer' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    asset_type: 'media', directory: '媒体库', delivery_mode: 'plan_items', account_id: 'writer',
  }))
})
