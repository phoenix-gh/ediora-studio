// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatClient } from './ChatClient'
import { ChatWorkspaceProvider } from '@/components/features/chat/ChatWorkspaceProvider'

const developerMode = vi.hoisted(() => ({ enabled: false }))
const chatApi = vi.hoisted(() => ({
  createChatPipeline: vi.fn(),
  getChatSession: vi.fn(),
  listChatDrafts: vi.fn(),
  listChatSessions: vi.fn(),
  listChatSkills: vi.fn(),
}))
const agentLogApi = vi.hoisted(() => ({
  listAgentTrajectory: vi.fn(),
  listAllAgentLogEvents: vi.fn(),
}))
const jobsApi = vi.hoisted(() => ({
  cancelPipeline: vi.fn(),
  confirmPipeline: vi.fn(),
  getJob: vi.fn(),
  getJobEvents: vi.fn(),
  rerunPipelineStage: vi.fn(),
  revisePipeline: vi.fn(),
  retryPipelineStage: vi.fn(),
}))

vi.mock('@/components/providers/DeveloperModeProvider', () => ({
  useDeveloperMode: () => developerMode.enabled,
}))
vi.mock('@/lib/api/chat', () => ({
  createChatPipeline: chatApi.createChatPipeline,
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  getChatSession: chatApi.getChatSession,
  listChatDrafts: chatApi.listChatDrafts,
  listChatSessions: chatApi.listChatSessions,
  listChatSkills: chatApi.listChatSkills,
  renameChatSession: vi.fn(),
  streamChatReply: vi.fn(),
}))
vi.mock('@/lib/api/jobs', () => ({
  cancelPipeline: jobsApi.cancelPipeline,
  confirmPipeline: jobsApi.confirmPipeline,
  getJob: jobsApi.getJob,
  getJobEvents: jobsApi.getJobEvents,
  imageUrlsForJob: vi.fn(() => []),
  rerunPipelineStage: jobsApi.rerunPipelineStage,
  revisePipeline: jobsApi.revisePipeline,
  retryPipelineStage: jobsApi.retryPipelineStage,
}))
vi.mock('@/lib/ai/agent-log-client', () => ({
  listAgentTrajectory: agentLogApi.listAgentTrajectory,
  listAllAgentLogEvents: agentLogApi.listAllAgentLogEvents,
}))

describe('ChatClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    developerMode.enabled = false
    chatApi.listChatSessions.mockResolvedValue([{
      id: 7,
      title: '现有会话',
      created_at: '2026-08-20T08:00:00Z',
      updated_at: '2026-08-20T08:00:00Z',
    }])
    chatApi.getChatSession.mockResolvedValue({
      id: 7,
      title: '现有会话',
      created_at: '2026-08-20T08:00:00Z',
      updated_at: '2026-08-20T08:00:00Z',
      messages: [],
    })
    chatApi.listChatSkills.mockResolvedValue([])
    chatApi.listChatDrafts.mockResolvedValue([])
    jobsApi.getJobEvents.mockResolvedValue({ events: [], next_after: 0 })
    agentLogApi.listAgentTrajectory.mockResolvedValue({
      session_key: 'chat:7',
      events: [],
      next_sequence: null,
      has_more: false,
      is_running: false,
      last_error: null,
    })
    agentLogApi.listAllAgentLogEvents.mockResolvedValue({
      events: [],
      has_more: false,
      next_sequence: null,
    })
  })

  it('does not load agent logs until the runtime trace dialog opens', async () => {
    developerMode.enabled = true
    const view = render(
      <ChatWorkspaceProvider>
        <ChatClient />
      </ChatWorkspaceProvider>,
    )

    await waitFor(() => expect(chatApi.getChatSession).toHaveBeenCalledWith(7))
    expect(chatApi.listChatSessions).toHaveBeenCalledTimes(1)
    expect(chatApi.getChatSession).toHaveBeenCalledTimes(1)
    expect(agentLogApi.listAllAgentLogEvents).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '运行轨迹' }))

    await waitFor(() => {
      expect(agentLogApi.listAgentTrajectory).toHaveBeenCalledWith({ session_id: 7 }, null, 500)
    })
    expect(chatApi.listChatSessions).toHaveBeenCalledTimes(1)
    expect(chatApi.getChatSession).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    view.unmount()
  })

  it('restores the thinking state and final message after reopening an active session', async () => {
    vi.useFakeTimers()
    chatApi.getChatSession
      .mockResolvedValueOnce({
        id: 7,
        title: '现有会话',
        created_at: '2026-08-20T08:00:00Z',
        updated_at: '2026-08-20T08:00:00Z',
        is_running: true,
        messages: [],
      })
      .mockResolvedValueOnce({
        id: 7,
        title: '现有会话',
        created_at: '2026-08-20T08:00:00Z',
        updated_at: '2026-08-20T08:00:00Z',
        is_running: false,
        messages: [{
          id: 1,
          role: 'assistant',
          parts: [{ type: 'text', text: '完成回复' }],
          text: '完成回复',
          created_at: '2026-08-20T08:01:00Z',
        }],
      })

    try {
      const view = render(
        <ChatWorkspaceProvider>
          <ChatClient />
        </ChatWorkspaceProvider>,
      )

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByText('正在思考并检索资料…')).toBeInTheDocument()
      expect(chatApi.getChatSession).toHaveBeenCalledWith(7)

      await act(async () => {
        vi.advanceTimersByTime(2_000)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByText('完成回复')).toBeInTheDocument()

      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the @Skill picker and submits structured pipeline invocations', async () => {
    chatApi.listChatSkills.mockResolvedValue([{
      name: 'article-drafting',
      displayName: '文章写作',
      description: '按资料写文章',
      version: '1.0.0',
    }])
    chatApi.createChatPipeline.mockResolvedValue({
      job: { id: 81 },
      user_message_id: 101,
      assistant_message_id: 102,
    })
    const view = render(
      <ChatWorkspaceProvider>
        <ChatClient />
      </ChatWorkspaceProvider>,
    )

    await waitFor(() => expect(chatApi.getChatSession).toHaveBeenCalledWith(7))
    const editor = screen.getByRole('textbox', { name: '消息内容' })
    editor.textContent = '请用('
    fireEvent.input(editor)
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    editor.append(document.createTextNode(')写一篇文章'))
    fireEvent.input(editor)
    fireEvent.submit(editor.closest('form')!)

    await waitFor(() => expect(chatApi.createChatPipeline).toHaveBeenCalledWith(7, expect.objectContaining({
      objective: '请用()写一篇文章',
      invocations: [expect.objectContaining({ skillName: 'article-drafting', skillDisplayName: '文章写作' })],
      messageParts: [
        { type: 'text', text: '请用(' },
        expect.objectContaining({ type: 'skill-invocation', skillName: 'article-drafting', skillDisplayName: '文章写作' }),
        { type: 'text', text: ')写一篇文章' },
      ],
    })))
    view.unmount()
  })

  it('keeps inline Skill content retryable when Pipeline creation fails', async () => {
    chatApi.listChatSkills.mockResolvedValue([{
      name: 'article-drafting',
      displayName: '文章写作',
      description: '按资料写文章',
      version: '1.0.0',
    }])
    chatApi.createChatPipeline
      .mockRejectedValueOnce(new Error('Pipeline 暂时不可用'))
      .mockResolvedValueOnce({ job: { id: 82 }, user_message_id: 103, assistant_message_id: 104 })
    const view = render(
      <ChatWorkspaceProvider>
        <ChatClient />
      </ChatWorkspaceProvider>,
    )

    await waitFor(() => expect(chatApi.getChatSession).toHaveBeenCalledWith(7))
    const editor = screen.getByRole('textbox', { name: '消息内容' })
    editor.textContent = '重试这篇文章'
    fireEvent.input(editor)
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.keyDown(editor, { key: '@', shiftKey: false, isComposing: false })
    fireEvent.click(screen.getByRole('button', { name: /文章写作/ }))
    fireEvent.submit(editor.closest('form')!)

    expect(await screen.findByRole('alert')).toHaveTextContent('Pipeline 暂时不可用')
    expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled()
    fireEvent.submit(editor.closest('form')!)
    await waitFor(() => expect(chatApi.createChatPipeline).toHaveBeenCalledTimes(2))
    view.unmount()
  })

  it('reconstructs a foldable Pipeline card from both persisted ref aliases', async () => {
    const pipelineJob = {
      id: 81,
      flow: 'skill_pipeline',
      title: '写作 Pipeline',
      status: 'awaiting_confirmation',
      plan_version: 1,
      run_epoch: 1,
      created_at: '2026-08-23T08:00:00Z',
      started_at: null,
      completed_at: null,
      steps: [],
      events: [],
      pipeline: {
        plan: { version: 1, objective: '请按方案写一篇文章', stages: [{
          position: 1,
          step_key: 'skill:01:article-drafting',
          invocation_id: 'one',
          skill_name: 'article-drafting',
          display_name: '文章写作',
          expected_output: '文章正文',
          capability_profile: 'writing',
          parameter_display_name: 'AI 产品观察',
          instruction: '内部指令不应进入消息卡片',
        }] },
        stages: [{
          id: 1,
          key: 'skill:01:article-drafting',
          attempt: 1,
          status: 'queued',
          input: {},
          output: {},
          error: '',
          retryable: false,
          artifacts: [],
          created_at: '2026-08-23T08:00:00Z',
          started_at: null,
          completed_at: null,
        }],
        artifacts: [],
      },
    }
    jobsApi.getJob.mockResolvedValue(pipelineJob)
    chatApi.getChatSession.mockResolvedValue({
      id: 7,
      title: '现有会话',
      created_at: '2026-08-20T08:00:00Z',
      updated_at: '2026-08-20T08:00:00Z',
      messages: [{
        id: 201,
        role: 'assistant',
        text: '已生成 Skill Pipeline，等待确认后开始执行。',
        parts: [{ type: 'pipeline-ref', jobId: 81 }],
        created_at: '2026-08-23T08:00:00Z',
      }],
    })
    const view = render(
      <ChatWorkspaceProvider>
        <ChatClient />
      </ChatWorkspaceProvider>,
    )

    await waitFor(() => expect(screen.getByRole('region', { name: 'Skill Pipeline' })).toBeInTheDocument())
    expect(jobsApi.getJob).toHaveBeenCalledWith(81)
    expect(screen.getByText(/AI 产品观察/)).toBeInTheDocument()
    expect(screen.queryByText('内部指令不应进入消息卡片')).not.toBeInTheDocument()
    view.unmount()
  })
})
