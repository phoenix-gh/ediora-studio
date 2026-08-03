// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { CreationRuleDialog } from './CreationRuleDialog'

it('submits a bounded recurring rule with the selected asset directory', () => {
  const onSubmit = vi.fn()
  render(<CreationRuleDialog open directories={[{ id: 1, name: '产品实验' }]} onClose={() => {}} onSubmit={onSubmit} />)

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
  render(<CreationRuleDialog open directories={[]} onClose={() => {}} onSubmit={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('执行方式'), { target: { value: 'once' } })
  fireEvent.click(screen.getByRole('button', { name: '保存规则' }))
  expect(screen.getByRole('alert')).toHaveTextContent('请选择素材目录')
  expect(screen.getByLabelText('执行日期')).toBeRequired()
})
