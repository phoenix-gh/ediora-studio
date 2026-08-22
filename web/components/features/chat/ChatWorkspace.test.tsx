// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/lib/api/chat'
import { ChatWorkspace } from './ChatWorkspace'
import { ChatWorkspaceProvider } from './ChatWorkspaceProvider'

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
vi.mock('@/components/providers/DeveloperModeProvider', () => ({
  useDeveloperMode: () => true,
}))
vi.mock('@/components/features/agent/AgentTrajectoryPanel', () => ({
  AgentTrajectoryPanel: () => <div data-testid="mock-trajectory-panel" />,
}))
vi.mock('@/lib/api/jobs', () => ({
  getJob: vi.fn(),
  imageUrlsForJob: vi.fn(() => []),
}))

const session7: ChatSession = {
  id: 7,
  title: '已有会话',
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
}

const session8: ChatSession = {
  id: 8,
  title: '另一个会话',
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
}

function detail(session: ChatSession) {
  return {
    ...session,
    is_running: false,
    messages: [{
      id: session.id * 10,
      role: 'assistant' as const,
      parts: [{ type: 'text', text: session.id === 7 ? '已有会话的消息' : '另一个会话的消息' }],
      text: session.id === 7 ? '已有会话的消息' : '另一个会话的消息',
      created_at: '2026-08-22T00:00:00Z',
    }],
  }
}

function renderWorkspace(variant: 'page' | 'floating') {
  return render(
    <ChatWorkspaceProvider>
      <ChatWorkspace
        variant={variant}
        onClose={variant === 'floating' ? () => undefined : undefined}
        onResetSize={variant === 'floating' ? () => undefined : undefined}
      />
    </ChatWorkspaceProvider>,
  )
}

describe('ChatWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.listChatSessions.mockResolvedValue([session7, session8])
    api.getChatSession.mockImplementation(async (id: number) => detail(id === 7 ? session7 : session8))
    api.listChatSkills.mockResolvedValue([])
    api.listChatDrafts.mockResolvedValue([])
    api.streamChatReply.mockResolvedValue(undefined)
  })

  it('renders the page variant with shared session management', async () => {
    renderWorkspace('page')

    expect(await screen.findByRole('heading', { name: 'AI 助手' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建对话' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '运行轨迹' })).toBeInTheDocument()
  })

  it('keeps floating controls in the header and puts the close control last', async () => {
    renderWorkspace('floating')

    const header = await screen.findByTestId('floating-chat-drag-handle')
    expect(screen.getByTestId('floating-chat-reset-size').closest('header')).toBe(header)

    const closeButton = screen.getByRole('button', { name: '关闭聊天助手' })
    expect(closeButton.querySelector('svg')).toHaveClass('lucide-x')
    expect(header.querySelectorAll('button').item(header.querySelectorAll('button').length - 1)).toBe(closeButton)
  })

  it('keeps cached messages isolated when switching sessions', async () => {
    const user = userEvent.setup()
    renderWorkspace('floating')

    await user.click(await screen.findByTestId('floating-chat-session-picker'))
    const firstSession = await screen.findByRole('button', { name: '切换到会话：已有会话' })
    await user.click(firstSession)
    expect(await screen.findByText('已有会话的消息')).toBeInTheDocument()

    await user.click(screen.getByTestId('floating-chat-session-picker'))
    await user.click(screen.getByRole('button', { name: '切换到会话：另一个会话' }))
    expect(await screen.findByText('另一个会话的消息')).toBeInTheDocument()
    expect(screen.queryByText('已有会话的消息')).not.toBeInTheDocument()
  })

  it('starts an empty local conversation without creating a database session', async () => {
    const user = userEvent.setup()
    renderWorkspace('page')

    await screen.findByRole('button', { name: '已有会话' })
    await user.click(screen.getByRole('button', { name: '新建对话' }))

    await waitFor(() => expect(screen.getByText(/还没有对话/)).toBeInTheDocument())
    expect(api.createChatSession).not.toHaveBeenCalled()
  })
})
