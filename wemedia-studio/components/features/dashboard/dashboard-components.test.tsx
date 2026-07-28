// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CreateTaskButton, CreateTaskDialog } from '@/components/features/CreateTaskDialog'
import { AlertsBar } from './AlertsBar'
import { GenerateDraftButton } from './GenerateDraftButton'
import { SourceStatusGrid } from './SourceStatusGrid'
import { TodayPlan } from './TodayPlan'

const { api, jobsApi, navigation, publishApi } = vi.hoisted(() => ({
  api: { apiFetch: vi.fn() },
  jobsApi: { createJob: vi.fn() },
  navigation: { refresh: vi.fn() },
  publishApi: { listPublishAccounts: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/api/client', () => api)
vi.mock('@/lib/api/jobs', () => jobsApi)
vi.mock('@/lib/api/publish-accounts', () => publishApi)
vi.mock('next/navigation', () => ({ useRouter: () => navigation }))

describe('dashboard components', () => {
  it('offers the empty today-plan generation action from the today-plan section', () => {
    render(<TodayPlan plan={null} />)

    expect(screen.getByRole('heading', { level: 2, name: '今日计划' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '去生成' })).toHaveAttribute('href', '/daily-plan')
  })

  it('renders warning alerts with semantic alert and action-link styling', () => {
    render(
      <AlertsBar
        alerts={[{ severity: 'warn', text: '需要检查数据源', action_label: '查看来源', href: '/sources' }]}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('data-variant', 'warning')
    expect(screen.getByRole('link', { name: /查看来源/ })).toHaveClass('text-primary')
  })

  it('marks a failed source using the semantic danger status badge', () => {
    render(
      <SourceStatusGrid
        sources={[{
          key: 'github',
          name: 'GitHub',
          href: '/github',
          schedule: '5m',
          last_status: 'error',
          last_message: '授权失效',
          last_run_at: null,
          today_new: 0,
        }]}
      />,
    )

    expect(screen.getByText('失败')).toHaveAttribute('data-status', 'danger')
  })

  it('disables draft generation with an accessible loading name while the request is pending', async () => {
    let resolveRequest: (value: { drafts_created: number }) => void
    api.apiFetch.mockImplementationOnce(() => new Promise(resolve => { resolveRequest = resolve }))
    const user = userEvent.setup()

    render(<GenerateDraftButton repoId="owner/repo" tag="v1.0.0" />)

    await user.click(screen.getByRole('button', { name: '生成草稿' }))

    expect(screen.getByRole('button', { name: '生成中…' })).toBeDisabled()
    resolveRequest!({ drafts_created: 1 })
  })

  it('renders the dashboard create-task action as a filled primary button', () => {
    render(<CreateTaskButton />)

    const action = screen.getByRole('button', { name: '发布创作任务' })
    expect(action).toHaveClass('bg-primary', 'text-primary-foreground')
    expect(action).not.toHaveClass('border-border')
  })

  it('uses the medium dialog and shared textarea for a new task', async () => {
    render(<CreateTaskDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'md')
    expect(screen.getByPlaceholderText('写下你的角度、想法，或粘贴参考素材；留空则由策划编辑自己搜料')).toHaveAttribute('data-slot', 'textarea')
  })

  it('shows inline required-field errors when task submission is incomplete', async () => {
    const user = userEvent.setup()
    render(<CreateTaskDialog open onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '发布' }))

    expect(screen.getByText('请选择发布账号')).toHaveAttribute('data-slot', 'field-error')
    expect(screen.getByText('请填写主题')).toHaveAttribute('data-slot', 'field-error')
  })

  it('names account and genre choice groups and exposes their selected buttons', async () => {
    const user = userEvent.setup()
    publishApi.listPublishAccounts.mockResolvedValueOnce([{
      id: 'account-1', name: 'Ediora', platform: 'wechat', positioning: '', audience: '', tone: '', topic_focus: [], taboo: [],
      word_range: {}, daily_quota: {}, image_style: '', cover_style: {}, voice_samples: [], style_rules: [], app_id: '', app_secret: '', is_active: true, created_at: '',
    }])
    render(<CreateTaskDialog open onOpenChange={vi.fn()} />)

    const accountChoices = await screen.findByRole('group', { name: '发布账号' })
    const genreChoices = screen.getByRole('group', { name: '体裁' })
    const account = within(accountChoices).getByRole('button', { name: /Ediora/ })
    const tutorial = within(genreChoices).getByRole('button', { name: '教程' })

    expect(account).toHaveAttribute('aria-pressed', 'false')
    expect(tutorial).toHaveAttribute('aria-pressed', 'false')
    await user.click(account)
    await user.click(tutorial)

    expect(account).toHaveAttribute('aria-pressed', 'true')
    expect(tutorial).toHaveAttribute('aria-pressed', 'true')
    expect(within(genreChoices).getByRole('button', { name: '评论' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('submits the established draft-job payload and closes after task creation', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    publishApi.listPublishAccounts.mockResolvedValueOnce([{
      id: 'account-1', name: 'Ediora', platform: 'wechat', positioning: '', audience: '', tone: '', topic_focus: [], taboo: [],
      word_range: {}, daily_quota: {}, image_style: '', cover_style: {}, voice_samples: [], style_rules: [], app_id: '', app_secret: '', is_active: true, created_at: '',
    }])
    jobsApi.createJob.mockResolvedValueOnce({ id: 42 })
    vi.stubGlobal('crypto', { randomUUID: () => 'task-idempotency-key' })

    render(<CreateTaskDialog open onOpenChange={onOpenChange} />)

    await user.click(await screen.findByRole('button', { name: /Ediora/ }))
    await user.type(screen.getByLabelText('主题 *'), '本地优先软件')
    await user.type(screen.getByLabelText('想法与素材（可选）'), '从用户体验切入')
    await user.click(screen.getByRole('button', { name: '教程' }))
    await user.type(screen.getByLabelText('备注（可选）'), '避免科普口吻')
    await user.click(screen.getByRole('button', { name: '发布' }))

    expect(jobsApi.createJob).toHaveBeenCalledWith({
      flow: 'draft',
      title: '本地优先软件',
      input: {
        account_id: 'account-1',
        idea: '从用户体验切入',
        genre: 'tutorial',
        note: '避免科普口吻',
      },
      idempotency_key: 'task-idempotency-key',
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
