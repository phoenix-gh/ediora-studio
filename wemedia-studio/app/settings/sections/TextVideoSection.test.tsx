// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { updateSettings } from '@/lib/api/settings'
import { makeSettings } from '@/lib/api/settings-test-fixtures'
import { TECH_TEXT_V1_DEFAULTS } from '@/remotion/templates/tech-text-v1/manifest'

import { TextVideoSection } from './TextVideoSection'

vi.mock('@/lib/api/settings', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/settings')>()
  return { ...original, updateSettings: vi.fn() }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('TextVideoSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('loads normalized template values and saves the complete defaults map', async () => {
    const settings = makeSettings({
      text_video_template_defaults: {
        'legacy-template@1': { title: 'keep me' },
        'tech-text-v1@1': {
          brandTitle: 'INITIAL',
        },
      },
    })
    const updated = makeSettings({
      text_video_template_defaults: {
        ...settings.text_video_template_defaults,
        'tech-text-v1@1': {
          ...TECH_TEXT_V1_DEFAULTS,
          brandTitle: 'CHANNEL ONE',
        },
      },
    })
    vi.mocked(updateSettings).mockResolvedValue(updated)
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(<TextVideoSection settings={settings} onSaved={onSaved} />)

    expect(screen.getByRole('combobox', { name: '模板' }))
      .toHaveTextContent('科技资讯动态文字')
    expect(screen.getByRole('textbox', { name: '品牌标题' }))
      .toHaveValue('INITIAL')

    await user.clear(screen.getByRole('textbox', { name: '品牌标题' }))
    await user.type(
      screen.getByRole('textbox', { name: '品牌标题' }),
      'CHANNEL ONE',
    )
    await user.click(screen.getByRole('button', { name: '保存模板默认值' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      text_video_template_defaults: {
        'legacy-template@1': { title: 'keep me' },
        'tech-text-v1@1': {
          ...TECH_TEXT_V1_DEFAULTS,
          brandTitle: 'CHANNEL ONE',
        },
      },
    }))
    expect(onSaved).toHaveBeenCalledWith(updated)
  })

  it('shows success only after the settings API returns', async () => {
    const settings = makeSettings()
    const request = deferred<typeof settings>()
    vi.mocked(updateSettings).mockReturnValue(request.promise)
    const user = userEvent.setup()

    render(<TextVideoSection settings={settings} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '保存模板默认值' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
    expect(toast.success).not.toHaveBeenCalled()

    await act(async () => {
      request.resolve(settings)
      await request.promise
    })

    expect(toast.success).toHaveBeenCalledWith('文字视频模板默认视觉已保存')
  })

  it('disables template selection and every template field while save is pending', async () => {
    const settings = makeSettings()
    const request = deferred<typeof settings>()
    vi.mocked(updateSettings).mockReturnValue(request.promise)
    const user = userEvent.setup()

    render(<TextVideoSection settings={settings} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '保存模板默认值' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
    expect(screen.getByRole('combobox', { name: '模板' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '品牌标题' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '品牌副标题' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: '强调色' })).toBeDisabled()
    expect(screen.getByLabelText('选择强调色')).toBeDisabled()
    for (const control of screen.getAllByRole('switch')) {
      expect(control).toHaveAttribute('aria-disabled', 'true')
    }
    expect(screen.getByRole('combobox', { name: '背景' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '文字密度' })).toBeDisabled()

    const brandTitle = screen.getByRole('textbox', { name: '品牌标题' })
    await user.type(brandTitle, 'MUTATION')
    expect(brandTitle).toHaveValue('EDIORA')

    await act(async () => {
      request.resolve(settings)
      await request.promise
    })
  })

  it('shows the schema-normalized values after a successful save', async () => {
    const settings = makeSettings()
    const updated = makeSettings({
      text_video_template_defaults: {
        'tech-text-v1@1': {
          ...TECH_TEXT_V1_DEFAULTS,
          brandTitle: 'BRAND',
        },
      },
    })
    vi.mocked(updateSettings).mockResolvedValue(updated)
    const user = userEvent.setup()

    render(<TextVideoSection settings={settings} onSaved={vi.fn()} />)
    const brandTitle = screen.getByRole('textbox', { name: '品牌标题' })
    await user.clear(brandTitle)
    await user.type(brandTitle, '  BRAND  ')
    await user.click(screen.getByRole('button', { name: '保存模板默认值' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      text_video_template_defaults: {
        'tech-text-v1@1': {
          ...TECH_TEXT_V1_DEFAULTS,
          brandTitle: 'BRAND',
        },
      },
    }))
    expect(brandTitle).toHaveValue('BRAND')
  })

  it('rebuilds the draft from the canonical server template entry after save', async () => {
    const settings = makeSettings({
      text_video_template_defaults: {
        'legacy-template@1': { title: 'keep me' },
        'tech-text-v1@1': { ...TECH_TEXT_V1_DEFAULTS },
      },
    })
    const updated = makeSettings({
      text_video_template_defaults: {
        'legacy-template@1': { title: 'keep me' },
        'tech-text-v1@1': {
          accentColor: '#FF3366',
        },
      },
    })
    const request = deferred<typeof updated>()
    vi.mocked(updateSettings).mockReturnValue(request.promise)
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(<TextVideoSection settings={settings} onSaved={onSaved} />)
    const accentColor = screen.getByRole('textbox', { name: '强调色' })
    await user.clear(accentColor)
    await user.type(accentColor, '#ff3366')
    await user.click(screen.getByRole('button', { name: '保存模板默认值' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      text_video_template_defaults: {
        'legacy-template@1': { title: 'keep me' },
        'tech-text-v1@1': {
          ...TECH_TEXT_V1_DEFAULTS,
          accentColor: '#ff3366',
        },
      },
    }))
    expect(accentColor).toHaveValue('#ff3366')

    await act(async () => {
      request.resolve(updated)
      await request.promise
    })

    expect(onSaved).toHaveBeenCalledWith(updated)
    expect(accentColor).toHaveValue('#FF3366')
    expect(screen.getByRole('textbox', { name: '品牌标题' }))
      .toHaveValue('EDIORA')
  })

  it('keeps unrelated validation errors while correcting one field', async () => {
    const settings = makeSettings()
    const user = userEvent.setup()

    render(<TextVideoSection settings={settings} onSaved={vi.fn()} />)
    const brandTitle = screen.getByRole('textbox', { name: '品牌标题' })
    const accentColor = screen.getByRole('textbox', { name: '强调色' })
    fireEvent.change(brandTitle, { target: { value: 'X'.repeat(33) } })
    fireEvent.change(accentColor, { target: { value: 'cyan' } })
    await user.click(screen.getByRole('button', { name: '保存模板默认值' }))

    expect(updateSettings).not.toHaveBeenCalled()
    expect(brandTitle).toHaveAttribute('aria-invalid', 'true')
    expect(accentColor).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(brandTitle, { target: { value: 'VALID' } })

    expect(brandTitle).toHaveAttribute('aria-invalid', 'false')
    expect(accentColor).toHaveAttribute('aria-invalid', 'true')
  })
})
