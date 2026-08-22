// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ChatSession,
  ChatSessionDetail,
  UIMessageStreamEvent,
} from '@/lib/api/chat'
import {
  ChatWorkspaceProvider,
  type ChatWorkspaceContextValue,
  useChatWorkspace,
} from './ChatWorkspaceProvider'

const api = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  getChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  renameChatSession: vi.fn(),
  listChatSkills: vi.fn(),
  listChatDrafts: vi.fn(),
  streamChatReply: vi.fn(),
}))

vi.mock('@/lib/api/chat', () => api)

const session7: ChatSession = {
  id: 7,
  title: '会话 7',
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
}

const session8: ChatSession = {
  id: 8,
  title: '会话 8',
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
}

function detail(session: ChatSession, isRunning = false, messages: ChatSessionDetail['messages'] = []): ChatSessionDetail {
  return {
    ...session,
    messages,
    is_running: isRunning,
  }
}

describe('ChatWorkspaceProvider', () => {
  let current: ChatWorkspaceContextValue

  function Probe() {
    current = useChatWorkspace()
    return null
  }

  function renderProvider() {
    render(
      <ChatWorkspaceProvider>
        <Probe />
      </ChatWorkspaceProvider>,
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    current = undefined as unknown as ChatWorkspaceContextValue
    api.listChatSessions.mockResolvedValue([])
    api.listChatSkills.mockResolvedValue([])
    api.listChatDrafts.mockResolvedValue([])
    api.createChatSession.mockResolvedValue(session7)
    api.getChatSession.mockResolvedValue(detail(session7))
    api.deleteChatSession.mockResolvedValue(undefined)
    api.renameChatSession.mockImplementation(async (id: number, title: string) => ({
      ...(id === 7 ? session7 : session8),
      title,
    }))
    api.streamChatReply.mockResolvedValue(undefined)
  })

  it('deduplicates simultaneous session-list requests and shares the active session', async () => {
    let resolveList!: (sessions: ChatSession[]) => void
    api.listChatSessions.mockReturnValueOnce(new Promise<ChatSession[]>(resolve => {
      resolveList = resolve
    }))
    api.getChatSession.mockResolvedValue(detail(session7, false, [{
      id: 70,
      role: 'assistant',
      parts: [{ type: 'text', text: '已加载' }],
      text: '已加载',
      created_at: '2026-08-22T00:00:00Z',
    }]))
    renderProvider()

    let first: Promise<ChatSession[]>
    let second: Promise<ChatSession[]>
    await act(async () => {
      first = current.refreshSessions()
      second = current.refreshSessions()
      resolveList([session7, session8])
      await Promise.all([first!, second!])
    })
    await act(async () => {
      await current.openSession(7)
    })

    expect(api.listChatSessions).toHaveBeenCalledTimes(1)
    expect(current.activeSessionId).toBe(7)
    expect(current.messages).toEqual([expect.objectContaining({ text: '已加载' })])
  })

  it('creates a session on the first send and forwards composer context', async () => {
    api.createChatSession.mockResolvedValue(session8)
    api.getChatSession.mockResolvedValue(detail(session8, false, [{
      id: 80,
      role: 'assistant',
      parts: [{ type: 'text', text: '回答' }],
      text: '回答',
      created_at: '2026-08-22T00:00:00Z',
    }]))
    renderProvider()

    await act(async () => {
      current.setSkillName('research-skill')
    })
    await act(async () => {
      current.setDraftId(42)
    })
    await act(async () => {
      await current.submit('研究这个主题')
    })

    expect(api.createChatSession).toHaveBeenCalledWith('研究这个主题')
    expect(api.streamChatReply).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 8,
      skillName: 'research-skill',
      draftId: 42,
    }))
    expect(current.activeSessionId).toBe(8)
    expect(current.messages).toEqual([expect.objectContaining({ text: '回答' })])
  })

  it('keeps a running session updating after switching to another session', async () => {
    let emit!: (event: UIMessageStreamEvent) => void
    let resolveStream!: () => void
    api.listChatSessions.mockResolvedValue([session7, session8])
    api.getChatSession.mockImplementation(async (id: number) => detail(id === 7 ? session7 : session8))
    api.streamChatReply.mockImplementation(async ({ onEvent }: { onEvent: (event: UIMessageStreamEvent) => void }) => {
      emit = onEvent
      await new Promise<void>(resolve => {
        resolveStream = resolve
      })
    })
    renderProvider()

    await act(async () => {
      await current.openSession(7)
    })
    let sending!: Promise<void>
    await act(async () => {
      sending = current.submit('开始运行')
      await waitFor(() => expect(api.streamChatReply).toHaveBeenCalled())
    })
    await act(async () => {
      await current.openSession(8)
      emit({ type: 'text-delta', id: 'text-7', delta: '后台结果' })
    })

    expect(current.activeSessionId).toBe(8)
    expect(current.state.messagesBySession['7']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [{ type: 'text', id: 'text-7', text: '后台结果' }],
        }),
      ]),
    )

    await act(async () => {
      resolveStream()
      await sending
    })
  })

  it('recovers a running session when its persisted state becomes complete', async () => {
    vi.useFakeTimers()
    try {
      api.getChatSession
        .mockResolvedValueOnce(detail(session7, true))
        .mockResolvedValueOnce(detail(session7, false, [{
          id: 71,
          role: 'assistant',
          parts: [{ type: 'text', text: '恢复完成' }],
          text: '恢复完成',
          created_at: '2026-08-22T00:00:00Z',
        }]))
      renderProvider()

      await act(async () => {
        await current.openSession(7)
      })
      expect(current.isActiveRunning).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(2_000)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(current.isActiveRunning).toBe(false)
      expect(current.messages).toEqual([expect.objectContaining({ text: '恢复完成' })])
    } finally {
      vi.useRealTimers()
    }
  })
})
