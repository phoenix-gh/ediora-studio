// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatClient } from './ChatClient'

const developerMode = vi.hoisted(() => ({ enabled: false }))
const chatApi = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  listChatDrafts: vi.fn(),
  listChatSessions: vi.fn(),
  listChatSkills: vi.fn(),
}))
const agentLogApi = vi.hoisted(() => ({
  listAgentTrajectory: vi.fn(),
  listAllAgentLogEvents: vi.fn(),
}))

vi.mock('@/components/providers/DeveloperModeProvider', () => ({
  useDeveloperMode: () => developerMode.enabled,
}))
vi.mock('@/lib/api/chat', () => ({
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
  getJob: vi.fn(),
  imageUrlsForJob: vi.fn(() => []),
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
    const view = render(<ChatClient />)

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
      const view = render(<ChatClient />)

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
})
