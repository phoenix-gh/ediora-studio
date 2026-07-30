// @vitest-environment jsdom

import { useState } from 'react'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'
import {
  makeVideoReadyProject,
} from '@/lib/text-video/test-fixtures'

import { TemplateSettingsDialog } from './TemplateSettingsDialog'


vi.mock('@/lib/api/settings', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...actual, getSettings: vi.fn() }
})

vi.mock('./RemotionPreview', () => ({
  RemotionPreview: ({
    project,
  }: {
    project: ReturnType<typeof makeVideoReadyProject>
  }) => (
    <output data-testid="template-draft-preview">
      {String(project.render_input.templateProps.brandTitle)}
    </output>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function DialogHarness({
  project = makeVideoReadyProject({
    render_input: {
      ...makeVideoReadyProject().render_input,
      templateProps: {
        ...makeVideoReadyProject().render_input.templateProps,
        brandTitle: 'CURRENT',
      },
    },
  }),
  onApply,
}: {
  project?: ReturnType<typeof makeVideoReadyProject>
  onApply(props: Record<string, unknown>): Promise<void>
}) {
  const [open, setOpen] = useState(true)
  return (
    <TemplateSettingsDialog
      open={open}
      project={project}
      onOpenChange={setOpen}
      onApply={onApply}
    />
  )
}

describe('TemplateSettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSettings).mockResolvedValue(makeSettings())
  })

  it('keeps edits in the draft preview and cancels without saving', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn().mockResolvedValue(undefined)
    const project = makeVideoReadyProject({
      render_input: {
        ...makeVideoReadyProject().render_input,
        templateProps: {
          ...makeVideoReadyProject().render_input.templateProps,
          brandTitle: 'CURRENT',
        },
      },
    })

    render(<DialogHarness project={project} onApply={onApply} />)
    const title = screen.getByRole('textbox', { name: '品牌标题' })
    expect(title).toHaveValue('CURRENT')
    expect(screen.getByTestId('template-draft-preview'))
      .toHaveTextContent('CURRENT')

    await user.clear(title)
    await user.type(title, 'DRAFT ONLY')

    expect(screen.getByTestId('template-draft-preview'))
      .toHaveTextContent('DRAFT ONLY')
    expect(project.render_input.templateProps.brandTitle).toBe('CURRENT')
    expect(onApply).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('restores the current platform entry into the draft without saving', async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({
      text_video_template_defaults: {
        'tech-text-v1@1': {
          brandTitle: 'PLATFORM',
        },
      },
    }))
    const user = userEvent.setup()
    const onApply = vi.fn().mockResolvedValue(undefined)

    render(<DialogHarness onApply={onApply} />)
    const restore = screen.getByRole('button', {
      name: '恢复平台默认值',
    })
    await waitFor(() => expect(restore).toBeEnabled())
    const title = screen.getByRole('textbox', { name: '品牌标题' })
    await user.clear(title)
    await user.type(title, 'LOCAL DRAFT')
    await user.click(restore)

    expect(title).toHaveValue('PLATFORM')
    expect(screen.getByTestId('template-draft-preview'))
      .toHaveTextContent('PLATFORM')
    expect(onApply).not.toHaveBeenCalled()
  })

  it('validates fields and awaits apply before closing', async () => {
    const request = deferred<void>()
    const onApply = vi.fn().mockReturnValue(request.promise)
    const user = userEvent.setup()

    render(<DialogHarness onApply={onApply} />)
    const accent = screen.getByRole('textbox', { name: '强调色' })
    fireEvent.change(accent, { target: { value: 'cyan' } })
    await user.click(screen.getByRole('button', { name: '应用' }))

    expect(onApply).not.toHaveBeenCalled()
    expect(accent).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(accent, { target: { value: '#123456' } })
    await user.click(screen.getByRole('button', { name: '应用' }))

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      brandTitle: 'CURRENT',
      accentColor: '#123456',
    }))
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByRole('button', { name: '正在应用…' })).toBeDisabled()
    const title = screen.getByRole('textbox', { name: '品牌标题' })
    expect(title).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '背景' })).toBeDisabled()
    expect(screen.getAllByRole('switch').every(control => (
      control.getAttribute('aria-disabled') === 'true'
    ))).toBe(true)
    expect(screen.getByRole('textbox', { name: '强调色' })).toBeDisabled()
    expect(screen.getByLabelText('选择强调色')).toBeDisabled()

    await user.type(title, 'MUTATED WHILE PENDING')
    expect(title).toHaveValue('CURRENT')
    expect(screen.getByTestId('template-draft-preview'))
      .toHaveTextContent('CURRENT')

    await act(async () => {
      request.resolve()
      await request.promise
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('preserves current values and disables restore when settings fail to load', async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error('平台设置不可用'))

    render(
      <DialogHarness onApply={vi.fn().mockResolvedValue(undefined)} />,
    )

    expect(screen.getByRole('textbox', { name: '品牌标题' }))
      .toHaveValue('CURRENT')
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('平台设置不可用')
    expect(screen.getByRole('button', {
      name: '恢复平台默认值',
    })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '品牌标题' }))
      .toHaveValue('CURRENT')
  })

  it('keeps the dialog open and user input intact after a backend save error', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn().mockRejectedValue(new Error('保存接口失败'))

    render(<DialogHarness onApply={onApply} />)
    const title = screen.getByRole('textbox', { name: '品牌标题' })
    await user.clear(title)
    await user.type(title, 'KEEP THIS')
    await user.click(screen.getByRole('button', { name: '应用' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('保存接口失败')
    expect(screen.getByRole('region', {
      name: '模板视觉设置内容',
    })).toContainElement(alert)
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(title).toHaveValue('KEEP THIS')
  })

  it('keeps header and footer reachable around one bounded scroll region', () => {
    render(
      <DialogHarness onApply={vi.fn().mockResolvedValue(undefined)} />,
    )

    const dialog = screen.getByRole('dialog')
    const heading = screen.getByRole('heading', {
      name: '模板视觉设置',
    })
    const scrollRegion = screen.getByRole('region', {
      name: '模板视觉设置内容',
    })
    const cancel = screen.getByRole('button', { name: '取消' })
    const footer = cancel.closest('[data-slot="dialog-footer"]')

    expect(dialog).toHaveClass(
      'h-[calc(100dvh-2rem)]',
      'grid-rows-[auto_minmax(0,1fr)_auto]',
      'overflow-hidden',
    )
    expect(scrollRegion).toHaveClass('min-h-0', 'overflow-y-auto')
    expect(footer).not.toBeNull()
    expect(footer).toHaveClass('shrink-0')
    expect(scrollRegion).not.toContainElement(heading)
    expect(scrollRegion).not.toContainElement(cancel)
    expect(dialog).toContainElement(heading)
    expect(dialog).toContainElement(cancel)
  })
})
