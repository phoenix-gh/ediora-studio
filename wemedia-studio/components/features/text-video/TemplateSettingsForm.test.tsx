// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TextVideoTemplateManifest } from '@/remotion/types'

import {
  TemplateSettingsForm,
  templateSettingsFieldErrors,
} from './TemplateSettingsForm'

type FakeTemplateProps = {
  brandTitle: string
  showBrand: boolean
  background: 'grid' | 'plain'
  accentColor: string
}

const fakeManifest = {
  id: 'fake-template',
  version: 1,
  compositionId: 'fake-template',
  name: '测试模板',
  component: () => null,
  propsSchema: z.object({
    brandTitle: z.string().min(1, '请输入品牌主标题'),
    showBrand: z.boolean(),
    background: z.enum(['grid', 'plain']),
    accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u, '请输入六位十六进制颜色'),
  }).strict(),
  defaultComposition: { width: 1080, height: 1920, fps: 30 },
  aspectRatios: ['9:16'],
  animations: ['fade-up'],
  transitions: ['soft-push'],
  defaults: {
    brandTitle: 'EDIORA',
    showBrand: true,
    background: 'grid',
    accentColor: '#69F6FF',
  },
  settings: [
    {
      id: 'brand',
      label: '品牌',
      fields: [
        {
          key: 'brandTitle',
          kind: 'text',
          label: '品牌主标题',
          maxLength: 32,
        },
        {
          key: 'showBrand',
          kind: 'boolean',
          label: '显示品牌',
        },
        {
          key: 'accentColor',
          kind: 'color',
          label: '强调色',
        },
      ],
    },
    {
      id: 'appearance',
      label: '画面',
      fields: [
        {
          key: 'background',
          kind: 'select',
          label: '背景',
          options: [
            { value: 'grid', label: '网格' },
            { value: 'plain', label: '纯色' },
          ],
        },
      ],
    },
  ],
} as const satisfies TextVideoTemplateManifest<FakeTemplateProps>

const value: FakeTemplateProps = {
  brandTitle: 'EDIORA',
  showBrand: true,
  background: 'grid',
  accentColor: '#69F6FF',
}

function ControlledFakeForm({
  onChange,
  fieldErrors = {},
}: {
  onChange(value: FakeTemplateProps): void
  fieldErrors?: Record<string, string>
}) {
  const [currentValue, setCurrentValue] = useState(value)

  return (
    <TemplateSettingsForm
      manifest={fakeManifest}
      value={currentValue}
      onChange={nextValue => {
        setCurrentValue(nextValue)
        onChange(nextValue)
      }}
      fieldErrors={fieldErrors}
    />
  )
}

describe('TemplateSettingsForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders manifest descriptors and emits controlled text and switch updates', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ControlledFakeForm onChange={onChange} />)

    expect(screen.getByRole('textbox', { name: '品牌主标题' }))
      .toHaveValue('EDIORA')
    await user.clear(screen.getByRole('textbox', { name: '品牌主标题' }))
    await user.type(
      screen.getByRole('textbox', { name: '品牌主标题' }),
      'CHANNEL ONE',
    )
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ brandTitle: 'CHANNEL ONE' }),
    )

    await user.click(screen.getByRole('switch', { name: '显示品牌' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ showBrand: false }),
    )
  })

  it('emits selected values and keeps both color controls on one controlled value', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ControlledFakeForm onChange={onChange} />)

    await user.click(screen.getByRole('combobox', { name: '背景' }))
    await user.click(await screen.findByRole('option', { name: '纯色' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ background: 'plain' }),
    )

    const colorText = screen.getByRole('textbox', { name: '强调色' })
    const colorPicker = screen.getByLabelText('选择强调色')
    expect(colorText).toHaveValue('#69F6FF')
    expect(colorPicker).toHaveValue('#69f6ff')

    await user.clear(colorText)
    await user.type(colorText, '#123456')
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ accentColor: '#123456' }),
    )
    expect(colorPicker).toHaveValue('#123456')

    fireEvent.change(colorPicker, { target: { value: '#abcdef' } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ accentColor: '#abcdef' }),
    )
    expect(colorText).toHaveValue('#abcdef')
  })

  it('marks the affected control invalid and displays its field error', () => {
    render(
      <TemplateSettingsForm
        manifest={fakeManifest}
        value={value}
        onChange={vi.fn()}
        fieldErrors={{ brandTitle: '请输入品牌主标题' }}
      />,
    )

    const title = screen.getByRole('textbox', { name: '品牌主标题' })
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(title.closest('[data-slot="field"]')).toHaveAttribute(
      'data-invalid',
      'true',
    )
    expect(screen.getByText('请输入品牌主标题')).toBeVisible()
  })
})

describe('templateSettingsFieldErrors', () => {
  it('keeps the first Zod issue for each top-level key', () => {
    const result = z.object({
      brandTitle: z.string().min(2, '标题太短').regex(/^[A-Z]+$/u, '标题只能使用大写字母'),
      nested: z.object({
        color: z.string().regex(/^#/u, '颜色格式无效'),
      }),
    }).safeParse({
      brandTitle: '',
      nested: { color: 'cyan' },
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(templateSettingsFieldErrors(result.error)).toEqual({
      brandTitle: '标题太短',
      nested: '颜色格式无效',
    })
  })
})
