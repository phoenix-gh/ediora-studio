// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatWorkspaceProvider } from './ChatWorkspaceProvider'
import {
  DEFAULT_FLOATING_CHAT_SIZE,
  FLOATING_CHAT_SIZE_STORAGE_KEY,
} from './floating-chat-size'
import { GlobalChatWidget } from './GlobalChatWidget'

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
vi.mock('@/components/features/agent/AgentTrajectoryPanel', () => ({
  AgentTrajectoryPanel: () => <div data-testid="mock-trajectory-panel" />,
}))
vi.mock('@/lib/api/jobs', () => ({
  getJob: vi.fn(),
  imageUrlsForJob: vi.fn(() => []),
}))

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

function renderWithProvider() {
  return render(
    <ChatWorkspaceProvider>
      <GlobalChatWidget />
    </ChatWorkspaceProvider>,
  )
}

describe('GlobalChatWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.listChatSessions.mockResolvedValue([])
    api.listChatSkills.mockResolvedValue([])
    api.listChatDrafts.mockResolvedValue([])
    api.streamChatReply.mockResolvedValue(undefined)
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: createStorage(),
    })
  })

  it('keeps the trigger visible before Chat data loads', () => {
    render(<GlobalChatWidget />)

    expect(screen.getByTestId('global-chat-trigger')).toBeInTheDocument()
  })

  it('opens a non-modal floating panel without an overlay', async () => {
    const user = userEvent.setup()
    renderWithProvider()

    await user.click(screen.getByTestId('global-chat-trigger'))

    expect(await screen.findByTestId('global-chat-panel')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeInTheDocument()
  })

  it('opens with a readable default panel size and exposes a visible resize affordance', async () => {
    const user = userEvent.setup()
    renderWithProvider()

    await user.click(screen.getByTestId('global-chat-trigger'))

    expect(screen.getByTestId('global-chat-panel')).toHaveStyle({ width: '560px', height: '720px' })
    expect(screen.getByRole('button', { name: '拖动调整窗口大小' })).toBeInTheDocument()
  })

  it('restores and resets the persisted panel size', async () => {
    const storage = window.localStorage
    storage.setItem(
      FLOATING_CHAT_SIZE_STORAGE_KEY,
      JSON.stringify({ width: 500, height: 640 }),
    )
    const user = userEvent.setup()
    renderWithProvider()

    await user.click(screen.getByTestId('global-chat-trigger'))

    expect(screen.getByTestId('global-chat-panel')).toHaveStyle({ width: '500px', height: '640px' })
    await user.click(screen.getByTestId('floating-chat-reset-size'))
    expect(screen.getByTestId('global-chat-panel')).toHaveStyle({
      width: `${DEFAULT_FLOATING_CHAT_SIZE.width}px`,
      height: `${DEFAULT_FLOATING_CHAT_SIZE.height}px`,
    })
  })

  it('clamps a pointer resize to the viewport and persists it', async () => {
    const user = userEvent.setup()
    renderWithProvider()

    await user.click(screen.getByTestId('global-chat-trigger'))
    const handle = await screen.findByTestId('floating-chat-resize-handle')

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 2_000, clientY: 2_000, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 2_000, clientY: 2_000, pointerId: 1 })

    expect(screen.getByTestId('global-chat-panel')).toHaveStyle({ width: '720px', height: '736px' })
    expect(JSON.parse(window.localStorage.getItem(FLOATING_CHAT_SIZE_STORAGE_KEY) ?? '{}')).toEqual({
      width: 720,
      height: 736,
    })
  })

  it('moves the floating panel when its header is dragged', async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight }
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const user = userEvent.setup()
    renderWithProvider()

    await user.click(screen.getByTestId('global-chat-trigger'))
    const header = await screen.findByTestId('floating-chat-drag-handle')
    const panel = screen.getByTestId('global-chat-panel')

    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100, pointerId: 2 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 60, pointerId: 2 })
    fireEvent.pointerUp(window, { clientX: 20, clientY: 60, pointerId: 2 })

    expect(panel).toHaveStyle({ left: '784px', top: '124px' })

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalViewport.width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalViewport.height })
  })
})
