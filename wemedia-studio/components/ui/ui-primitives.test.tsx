// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Badge } from './badge'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { Input } from './input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select'
import { Textarea } from './textarea'

describe('UI primitive contracts', () => {
  it.each([
    ['sm', 'h-8'],
    ['default', 'h-9'],
    ['lg', 'h-10'],
  ] as const)('maps %s buttons to %s', (size, className) => {
    render(<Button size={size}>Action</Button>)

    expect(screen.getByRole('button', { name: 'Action' })).toHaveClass(className)
  })

  it('uses 36px default text controls', () => {
    render(
      <>
        <Input aria-label="Title" />
        <Textarea aria-label="Body" />
      </>,
    )

    expect(screen.getByLabelText('Title')).toHaveClass('h-9')
    expect(screen.getByLabelText('Body')).toHaveClass('text-sm')
  })

  it('uses the themed control surface for Base UI select triggers', () => {
    render(
      <Select defaultValue="light">
        <SelectTrigger aria-label="主题">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="light">浅色</SelectItem>
        </SelectContent>
      </Select>,
    )

    expect(screen.getByRole('combobox', { name: '主题' })).toHaveClass(
      'bg-control',
      'hover:bg-control-hover',
    )
  })

  it.each(['data', 'ai', 'success', 'warning', 'info'] as const)(
    'renders the %s semantic badge',
    variant => {
      render(<Badge variant={variant}>{variant}</Badge>)

      expect(screen.getByText(variant)).toHaveAttribute('data-variant', variant)
    },
  )

  it('opens an accessible dropdown menu with destructive action styling', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>更多操作</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem>编辑订阅</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">删除订阅</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))

    expect(await screen.findByRole('menuitem', { name: '编辑订阅' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '删除订阅' })).toHaveAttribute('data-variant', 'destructive')
  })
})
