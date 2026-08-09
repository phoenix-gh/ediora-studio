// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AsyncState } from './AsyncState'
import { AppShell } from './AppShell'
import { FormSection } from './FormSection'
import { PageHeader } from './PageHeader'
import { SplitWorkspace } from './SplitWorkspace'
import { StatusBadge } from './StatusBadge'
import { WorkspaceToolbar } from './WorkspaceToolbar'

describe('layout components', () => {
  it('keeps document overflow at the viewport shell and scrolls ordinary pages in main content', () => {
    render(
      <AppShell sidebar={<aside>Navigation</aside>}>
        <div>Page content</div>
      </AppShell>,
    )

    const content = screen.getByText('Page content').closest('main')
    expect(content).toHaveClass('h-dvh', 'overflow-y-auto')
    expect(content?.parentElement).toHaveClass('h-dvh', 'overflow-hidden')
  })

  it('renders one page heading and a named action region', () => {
    render(<PageHeader title="创作资产" actions={<button>新增素材</button>} />)

    expect(screen.getByRole('heading', { level: 1, name: '创作资产' })).toBeTruthy()
    expect(screen.getByRole('group', { name: '页面操作' })).toBeTruthy()
    expect(screen.getByRole('banner')).toHaveAttribute('data-slot', 'page-header')
    expect(screen.getByRole('banner')).toHaveClass('min-h-[var(--app-header-height)]')
  })

  it('exposes stable list and editor regions', () => {
    render(
      <SplitWorkspace
        listLabel="素材列表"
        editorLabel="素材编辑器"
        list={<div>List</div>}
        editor={<div>Editor</div>}
      />,
    )

    const list = screen.getByRole('region', { name: '素材列表' })
    const editor = screen.getByRole('region', { name: '素材编辑器' })
    expect(list).toHaveClass('w-1/4', 'min-w-[280px]', 'max-w-[360px]', 'shrink-0')
    expect(editor).toHaveClass('min-w-0', 'flex-1')
    expect(list.parentElement).toHaveClass('flex')
  })

  it('groups form content under its visible title and actions', () => {
    render(
      <FormSection title="发布设置" actions={<button>保存</button>}>
        <input aria-label="平台" />
      </FormSection>,
    )

    expect(screen.getByRole('region', { name: '发布设置' })).toContainElement(screen.getByLabelText('平台'))
    expect(screen.getByRole('group', { name: '发布设置操作' })).toBeTruthy()
  })

  it('labels a form section when its title is a React node', () => {
    render(
      <FormSection title={<span>高级发布设置</span>}>
        <input aria-label="发布账号" />
      </FormSection>,
    )

    expect(screen.getByRole('region', { name: '高级发布设置' })).toContainElement(screen.getByLabelText('发布账号'))
  })

  it('provides a labelled workspace toolbar with a far-end action group', () => {
    render(<WorkspaceToolbar title="素材" count="12" actions={<button>上传</button>}>筛选器</WorkspaceToolbar>)

    expect(screen.getByRole('toolbar', { name: '素材工作区' })).toHaveTextContent('12')
    expect(screen.getByRole('group', { name: '工作区操作' })).toBeTruthy()
  })

  it.each(['loading', 'empty', 'error'] as const)('renders an accessible %s state', variant => {
    render(<AsyncState variant={variant} title={`${variant} title`} />)

    expect(screen.getByRole('status', { name: `${variant} title` })).toBeTruthy()
  })

  it('names an async state from a React node title', () => {
    render(<AsyncState variant="empty" title={<strong>没有可用素材</strong>} />)

    expect(screen.getByRole('status', { name: '没有可用素材' })).toBeTruthy()
  })

  it.each(['neutral', 'data', 'ai', 'success', 'warning', 'danger', 'info'] as const)(
    'maps %s to a semantic status badge',
    variant => {
      render(<StatusBadge variant={variant}>{variant}</StatusBadge>)

      expect(screen.getByText(variant)).toHaveAttribute('data-variant')
    },
  )
})
