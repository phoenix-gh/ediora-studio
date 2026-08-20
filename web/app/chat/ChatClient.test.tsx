// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react'
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
    agentLogApi.listAllAgentLogEvents.mockResolvedValue({
      events: [],
      has_more: false,
      next_sequence: null,
    })
  })

  it('does not reopen the first session when runtime developer mode resolves', async () => {
    const view = render(<ChatClient />)

    await waitFor(() => expect(chatApi.getChatSession).toHaveBeenCalledWith(7))
    expect(chatApi.listChatSessions).toHaveBeenCalledTimes(1)
    expect(chatApi.getChatSession).toHaveBeenCalledTimes(1)

    developerMode.enabled = true
    view.rerender(<ChatClient />)

    await waitFor(() => {
      expect(agentLogApi.listAllAgentLogEvents).toHaveBeenCalledWith({
        session_id: 7,
        limit: 500,
      })
    })
    expect(chatApi.listChatSessions).toHaveBeenCalledTimes(1)
    expect(chatApi.getChatSession).toHaveBeenCalledTimes(1)
  })
})
