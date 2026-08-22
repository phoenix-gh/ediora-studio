# 全局浮动 Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax (- [ ]) for tracking.

**Goal:** 在根布局中增加一个跨路由持久存在的完整浮动 Chat，支持共享多会话、流式 Agent 能力、非模态交互和可调整面板尺寸。

**Architecture:** 在根布局中挂载 ChatWorkspaceProvider 和 GlobalChatWidget，Provider 统一管理 /chat 页面与浮动面板共享的会话、消息缓存、运行状态和流式事件。ChatWorkspace 提供 page/floating 两种布局，浮动面板使用非模态 Dialog 和固定右下角的宽高调整能力。

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Base UI Dialog, Tailwind CSS, Vitest, Testing Library, pnpm.

**Spec:** docs/superpowers/specs/2026-08-22-global-floating-chat-design.md

## Global Constraints

- Provider 和 GlobalChatWidget 必须挂在根布局持久化层，不能按 pathname 重建。
- 浮动面板与 /chat 使用同一个 GET /api/chat/sessions 会话池，不增加后端会话表或独立接口。
- 浮动面板必须使用非模态 Dialog，不显示全屏遮罩，不锁定页面滚动。
- 默认面板尺寸为 380px × 560px，位置固定右下角，只允许调整宽度和高度，不实现拖动。
- 尺寸存储使用版本化 localStorage key，并在面板打开前恢复，避免打开瞬间跳变。
- 关闭面板、切换页面和切换会话不能取消流式请求；运行状态按会话隔离。
- 本次不采集当前页面上下文，不修改 Agent Prompt，不增加页面上下文后端协议。
- 只运行变更相关的 Vitest、ESLint、TypeScript 和 diff 检查，不默认运行完整测试套件。
- 所有前端命令从 web 目录执行，包管理器使用 pnpm。

---

## 文件与模块清单

### 新建

- web/components/features/chat/chat-workspace-types.ts：共享展示消息、工具事件、审批参数和 Provider 状态类型。
- web/components/features/chat/chat-workspace-state.ts：纯函数消息构造、模型消息转换和流式事件增量合并。
- web/components/features/chat/chat-workspace-state.test.ts：纯状态函数测试。
- web/components/features/chat/ChatMessageView.tsx：消息、Markdown、图片、工具状态和审批展示。
- web/components/features/chat/ChatMessageView.test.tsx：消息和工具展示测试。
- web/components/features/chat/ChatAgentLogDialog.tsx：从 app 路由层抽出的共享轨迹 Dialog。
- web/components/features/chat/ChatWorkspaceProvider.tsx：共享会话池、消息缓存和运行层。
- web/components/features/chat/ChatWorkspaceProvider.test.tsx：Provider 会话、流式、审批和恢复测试。
- web/components/features/chat/ChatSessionList.tsx：page/floating 共用的会话列表。
- web/components/features/chat/ChatComposer.tsx：输入框、技能/草稿上下文和发送按钮。
- web/components/features/chat/ChatWorkspace.tsx：page/floating 两种 Chat 布局。
- web/components/features/chat/ChatWorkspace.test.tsx：工作区和会话操作测试。
- web/components/features/chat/floating-chat-size.ts：浮动面板尺寸常量、持久化读取和边界计算。
- web/components/features/chat/floating-chat-size.test.ts：尺寸边界和存储测试。
- web/components/features/chat/GlobalChatWidget.tsx：全局固定入口、非模态浮窗和尺寸调整。
- web/components/features/chat/GlobalChatWidget.test.tsx：入口、非模态面板和尺寸恢复测试。

### 修改

- web/components/ui/dialog.tsx：增加可选的 showOverlay 属性，保持现有 Dialog 默认行为不变。
- web/components/ui/dialog.test.tsx：覆盖关闭遮罩后的 Dialog 渲染。
- web/app/chat/ChatAgentLogDialog.tsx：保留兼容导出，实际实现转移到 features/chat。
- web/app/chat/ChatClient.tsx：改为 page 版 ChatWorkspace 入口。
- web/app/chat/ChatClient.test.tsx：使用 ChatWorkspaceProvider 测试页面版工作区，保留现有回归场景。
- web/app/layout.tsx：挂载 ChatWorkspaceProvider 和 GlobalChatWidget。

### 不修改

- backend/routers/chat.py；
- web/app/api/chat/route.ts；
- Agent 运行轨迹后端协议；
- ChatSession、ChatMessage 数据模型。

---

### Task 1: 建立共享 Chat 类型与流式状态纯函数

**Files:**
- Create: web/components/features/chat/chat-workspace-types.ts
- Create: web/components/features/chat/chat-workspace-state.ts
- Test: web/components/features/chat/chat-workspace-state.test.ts
- Reference: web/lib/api/chat.ts

**Interfaces:**

- Produces DisplayMessage, ToolEventPart, ChatApprovalArgs, ChatComposerSelection and ChatWorkspaceState.
- Produces makeLocalMessage(role, parts).
- Produces toModelMessages(messages).
- Produces applyChatStreamEvent(messages, assistantMessageId, event).

Use string keys for per-session records so the state remains serializable:

~~~ts
export type ChatWorkspaceState = {
  sessions: ChatSession[]
  activeSessionId: number | null
  messagesBySession: Record<string, DisplayMessage[]>
  loadingBySession: Record<string, boolean>
  runningBySession: Record<string, boolean>
  errorsBySession: Record<string, string | null>
  composer: ChatComposerSelection
}
~~~

- [ ] **Step 1: Write the failing pure-function tests**

Add tests for:

~~~ts
it('only appends a text delta to the targeted assistant message', () => {
  const next = applyChatStreamEvent(
    [userMessage, assistantMessage, otherSessionMessage],
    'assistant-1',
    { type: 'text-delta', id: 'text-1', delta: '你好' },
  )

  expect(next[1].parts).toEqual([{ type: 'text', id: 'text-1', text: '你好' }])
  expect(next[2]).toEqual(otherSessionMessage)
})

it('merges tool start, input, and output by toolCallId', () => {
  const withStart = applyChatStreamEvent([], 'assistant-1', {
    type: 'tool-input-start',
    toolCallId: 'call-1',
    toolName: 'searchInformationSources',
  })
  const withInput = applyChatStreamEvent(withStart, 'assistant-1', {
    type: 'tool-input-available',
    toolCallId: 'call-1',
    input: { query: 'AI' },
  })
  const withOutput = applyChatStreamEvent(withInput, 'assistant-1', {
    type: 'tool-output-available',
    toolCallId: 'call-1',
    output: { items: [] },
  })

  expect(withOutput[0].parts[0]).toMatchObject({
    type: 'tool-event',
    toolCallId: 'call-1',
    state: 'completed',
    input: { query: 'AI' },
    output: { items: [] },
  })
})
~~~

Also test makeLocalMessage creates a stable local ID, toModelMessages excludes tool-role records, and an error event adds an error text part without removing existing tool parts.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/chat-workspace-state.test.ts
~~~

Expected: FAIL because the new state module and functions do not exist.

- [ ] **Step 3: Write the minimal implementation**

Move the existing DisplayMessage, ToolEventPart, toModelMessages, makeLocalMessage, and stream-event update logic out of ChatClient into the new modules. Preserve the existing event semantics:

~~~ts
export function applyChatStreamEvent(
  messages: DisplayMessage[],
  assistantMessageId: string,
  event: UIMessageStreamEvent,
): DisplayMessage[] {
  // Locate assistantMessageId only, then merge text/tool/error data immutably.
}
~~~

For tool events, use toolCallId as the identity. For text deltas, use the event id and append to the existing text part. For error, append a text part containing the returned error detail and leave completed tool parts intact.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same Vitest command. Expected: all state-module tests pass.

- [ ] **Step 5: Commit the isolated state layer**

~~~bash
git add web/components/features/chat/chat-workspace-types.ts \
  web/components/features/chat/chat-workspace-state.ts \
  web/components/features/chat/chat-workspace-state.test.ts
git commit -m "refactor: extract shared chat workspace state"
~~~

---

### Task 2: Extract shared message and trajectory rendering

**Files:**
- Create: web/components/features/chat/ChatMessageView.tsx
- Create: web/components/features/chat/ChatMessageView.test.tsx
- Create: web/components/features/chat/ChatAgentLogDialog.tsx
- Modify: web/app/chat/ChatAgentLogDialog.tsx
- Reference: web/app/chat/ChatClient.tsx, web/components/features/chat/ChatMarkdown.tsx

**Interfaces:**

- Produces ChatMessageView({ message, onApproval }).
- Produces ChatApprovalHandler = (messageId, toolCallId, approvalId, approved) => void.
- Keeps ChatAgentLogDialog props unchanged:

~~~ts
type ChatAgentLogDialogProps = {
  sessionId: number | null
  open: boolean
  developerModeEnabled: boolean
  onOpenChange: (open: boolean) => void
}
~~~

- The existing app-level ChatAgentLogDialog becomes a re-export so current imports and tests do not break while the shared workspace imports the feature component directly.

- [ ] **Step 1: Write failing component tests**

Cover a user message, an assistant Markdown message, a running tool, a completed tool result, and a pending approval:

~~~tsx
it('renders tool approval actions with the persisted message identity', async () => {
  const onApproval = vi.fn()
  render(
    <ChatMessageView
      message={assistantWithPendingApproval}
      onApproval={onApproval}
    />,
  )

  await userEvent.click(screen.getByRole('button', { name: '批准' }))
  expect(onApproval).toHaveBeenCalledWith(12, 'call-1', 'approval-1', true)
})
~~~

Add a regression assertion that two tool parts with the same tool name but different toolCallId render independent rows and actions.

- [ ] **Step 2: Run the focused tests and verify the new test fails**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/ChatMessageView.test.tsx app/chat/ChatAgentLogDialog.test.tsx
~~~

Expected: the new component test fails because ChatMessageView has not been created; the existing trajectory test remains the baseline.

- [ ] **Step 3: Move the render-only logic**

Move the following logic without changing visible copy or existing tool behavior:

- GeneratedImagePreview and ImageJobPreview;
- ToolActivityGroup;
- MessageBubble;
- tool labels, activity summary, time formatting, and image/job previews.

The new view must receive data and callbacks as props; it must not load sessions or own stream state. Keep tool-row keys based on toolCallId and a deterministic fallback, never only the tool name.

Copy ChatAgentLogDialog into the feature directory, then replace the app file with:

~~~ts
export { ChatAgentLogDialog } from '@/components/features/chat/ChatAgentLogDialog'
~~~

- [ ] **Step 4: Run the focused tests and the existing Chat regression**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/ChatMessageView.test.tsx \
  app/chat/ChatAgentLogDialog.test.tsx app/chat/ChatClient.test.tsx
~~~

Expected: all selected tests pass before the page component is migrated.

- [ ] **Step 5: Commit the shared renderers**

~~~bash
git add web/components/features/chat/ChatMessageView.tsx \
  web/components/features/chat/ChatMessageView.test.tsx \
  web/components/features/chat/ChatAgentLogDialog.tsx \
  web/app/chat/ChatAgentLogDialog.tsx
git commit -m "refactor: share chat message and trace views"
~~~

---

### Task 3: Implement the shared ChatWorkspaceProvider

**Files:**
- Create: web/components/features/chat/ChatWorkspaceProvider.tsx
- Create: web/components/features/chat/ChatWorkspaceProvider.test.tsx
- Modify: web/components/features/chat/chat-workspace-types.ts
- Reference: web/lib/api/chat.ts, web/app/chat/chat-title.ts, web/components/providers/DeveloperModeProvider.tsx

**Interfaces:**

Export:

~~~ts
export type ChatWorkspaceContextValue = {
  state: ChatWorkspaceState
  sessions: ChatSession[]
  activeSessionId: number | null
  messages: DisplayMessage[]
  isActiveLoading: boolean
  isActiveRunning: boolean
  activeError: string | null
  skills: ChatSkill[]
  drafts: ChatDraft[]
  refreshSessions: () => Promise<ChatSession[]>
  openSession: (sessionId: number) => Promise<void>
  startNewConversation: () => void
  renameSession: (sessionId: number, title: string) => Promise<void>
  removeSession: (sessionId: number) => Promise<void>
  submit: (text: string) => Promise<void>
  respondToApproval: (args: ChatApprovalArgs) => Promise<void>
  setSkillName: (skillName: string) => void
  setDraftId: (draftId: number | null) => void
  retrySession: (sessionId: number) => Promise<void>
}

export function ChatWorkspaceProvider(props: { children: React.ReactNode }): JSX.Element
export function useChatWorkspace(): ChatWorkspaceContextValue
~~~

- refreshSessions must deduplicate simultaneous list requests from page and floating consumers.
- openSession sets activeSessionId immediately, shows cached messages if present, then loads missing detail.
- submit creates a session with titleFromFirstMessage only when no active persisted session exists.
- respondToApproval includes sessionId in its argument so a callback cannot approve a tool in whichever session happens to be active later.
- runningBySession and messagesBySession are updated by session ID, not by the current component instance.

- [ ] **Step 1: Write failing Provider tests**

Mock the functions from web/lib/api/chat.ts. Add tests for:

~~~tsx
it('shares the session list and active session across two consumers', async () => {
  const first = renderHook(() => useChatWorkspace(), { wrapper: Provider })
  const second = renderHook(() => useChatWorkspace(), { wrapper: Provider })

  await act(() => first.result.current.refreshSessions())
  await act(() => second.result.current.openSession(7))

  expect(first.result.current.activeSessionId).toBe(7)
  expect(second.result.current.activeSessionId).toBe(7)
  expect(listChatSessions).toHaveBeenCalledTimes(1)
})

it('keeps a running session updating after switching to another session', async () => {
  // Start session 7, switch to session 8, emit text for session 7, then finish it.
  const result = renderHook(() => useChatWorkspace(), { wrapper: Provider })

  expect(result.current.state.runningBySession['7']).toBe(true)
  expect(result.current.state.messagesBySession['7']).toContainEqual(
    expect.objectContaining({ id: 'assistant-7' }),
  )
})
~~~

Also cover create-on-first-send, rename/delete, approval routing by session ID, stream errors retaining the local messages, and is_running recovery with fake timers.

- [ ] **Step 2: Run the focused Provider tests and verify they fail**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/ChatWorkspaceProvider.test.tsx
~~~

Expected: FAIL because the Provider and context are not defined.

- [ ] **Step 3: Write the minimal Provider implementation**

Use a reducer or immutable state updates to keep per-session records isolated. The send path must follow this shape:

~~~ts
async function submit(text: string) {
  const sessionId = await ensureActiveSession(text)
  const userMessage = makeLocalMessage('user', [{ type: 'text', text }])
  const assistantMessage = makeLocalMessage('assistant', [])
  const requestMessages = toModelMessages([
    ...messagesBySession[sessionKey(sessionId)],
    userMessage,
  ])

  updateSessionMessages(sessionId, current => [
    ...current,
    userMessage,
    assistantMessage,
  ])
  setSessionRunning(sessionId, true)

  try {
    await streamChatReply({
      sessionId,
      messages: requestMessages,
      skillName: composer.skillName || undefined,
      draftId: composer.draftId ?? undefined,
      onEvent: event => updateSessionMessages(
        sessionId,
        current => applyChatStreamEvent(current, String(assistantMessage.id), event),
      ),
    })
    await reloadSession(sessionId)
    await refreshSessions()
  } catch (error) {
    setSessionError(sessionId, messageFromError(error, '发送消息失败'))
  } finally {
    setSessionRunning(sessionId, false)
  }
}
~~~

Do not create an AbortController tied to panel visibility or pathname. Add one recovery effect that polls only the session IDs marked running, uses getChatSession, replaces messages when a run completes, and stops polling for completed sessions. Keep skills and drafts loaded once per Provider.

- [ ] **Step 4: Run the Provider tests and verify they pass**

Run the same focused command. Expected: all Provider state, stream, approval, deletion, and recovery tests pass.

- [ ] **Step 5: Commit the shared runtime**

~~~bash
git add web/components/features/chat/chat-workspace-types.ts \
  web/components/features/chat/ChatWorkspaceProvider.tsx \
  web/components/features/chat/ChatWorkspaceProvider.test.tsx
git commit -m "feat: add shared chat workspace provider"
~~~

---

### Task 4: Build the shared page/floating Chat workspace

**Files:**
- Create: web/components/features/chat/ChatSessionList.tsx
- Create: web/components/features/chat/ChatComposer.tsx
- Create: web/components/features/chat/ChatWorkspace.tsx
- Create: web/components/features/chat/ChatWorkspace.test.tsx
- Modify: web/app/chat/ChatClient.tsx
- Modify: web/app/chat/ChatClient.test.tsx

**Interfaces:**

~~~ts
export type ChatWorkspaceProps = {
  variant: 'page' | 'floating'
  onClose?: () => void
  onOpenFullChat?: () => void
}

export function ChatWorkspace(props: ChatWorkspaceProps): JSX.Element
~~~

ChatSessionList consumes sessions, activeSessionId, runningBySession, loading, and CRUD callbacks. ChatComposer consumes skills, drafts, composer selection, submit callback, and the active running state. Neither component calls the Chat API directly.

- [ ] **Step 1: Write failing workspace tests**

Test both variants:

~~~tsx
it('renders the page variant with shared session management', async () => {
  render(
    <ChatWorkspaceProvider>
      <ChatWorkspace variant="page" />
    </ChatWorkspaceProvider>,
  )

  expect(await screen.findByRole('heading', { name: 'AI 助手' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '新建对话' })).toBeInTheDocument()
})

it('keeps cached messages when switching sessions', async () => {
  render(
    <ChatWorkspaceProvider>
      <ChatWorkspace variant="floating" />
    </ChatWorkspaceProvider>,
  )

  await userEvent.click(screen.getByRole('button', { name: '已有会话' }))
  await userEvent.click(screen.getByRole('button', { name: '另一个会话' }))

  expect(screen.queryByText('已有会话的消息')).not.toBeInTheDocument()
  expect(screen.getByText('另一个会话的消息')).toBeInTheDocument()
})
~~~

Add tests for rename, delete, new conversation, composer Enter/Shift+Enter behavior, disabled send while the active session is running, and trace button availability in developer mode.

- [ ] **Step 2: Run the focused workspace tests and verify they fail**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/ChatWorkspace.test.tsx
~~~

Expected: FAIL because the workspace components are not defined.

- [ ] **Step 3: Write the minimal shared workspace**

Move the existing ChatClient layout into focused components:

- ChatSessionList owns only list rendering, inline title editing, and callback invocation;
- ChatComposer owns the textarea, ChatContextPicker and submit button;
- ChatWorkspace owns local input/trace visibility and composes Provider state with ChatMessageView and ChatAgentLogDialog.

The workspace must load the session list in an effect when it mounts. It must not clear cached active messages while refreshSessions or openSession is in flight. Use the existing page copy and ChatContextPicker behavior unless a compact floating layout requires a smaller className.

For the floating variant, render the session list as a collapsible panel and keep the message list/input in separate flex children with min-h-0. For the page variant, preserve the existing full-height layout.

- [ ] **Step 4: Replace ChatClient with the page wrapper and run regression tests**

Make ChatClient a thin component:

~~~tsx
export function ChatClient() {
  return <ChatWorkspace variant="page" />
}
~~~

Update ChatClient.test.tsx to render ChatClient inside ChatWorkspaceProvider. Preserve the existing tests for deferred trajectory loading and restoring a running session.

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/ChatWorkspace.test.tsx \
  app/chat/ChatClient.test.tsx app/chat/ChatAgentLogDialog.test.tsx
~~~

Expected: all workspace and existing Chat tests pass.

- [ ] **Step 5: Commit the shared workspaces**

~~~bash
git add web/components/features/chat/ChatSessionList.tsx \
  web/components/features/chat/ChatComposer.tsx \
  web/components/features/chat/ChatWorkspace.tsx \
  web/components/features/chat/ChatWorkspace.test.tsx \
  web/app/chat/ChatClient.tsx web/app/chat/ChatClient.test.tsx
git commit -m "refactor: share page and floating chat workspaces"
~~~

---

### Task 5: Add non-modal Dialog support and panel-size primitives

**Files:**
- Modify: web/components/ui/dialog.tsx
- Modify: web/components/ui/dialog.test.tsx
- Create: web/components/features/chat/floating-chat-size.ts
- Create: web/components/features/chat/floating-chat-size.test.ts

**Interfaces:**

Add an optional showOverlay prop to DialogContent with the existing default preserved:

~~~tsx
function DialogContent({
  showOverlay = true,
  ...
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  showOverlay?: boolean
  size?: keyof typeof dialogSizeClass
}) {
  return (
    <DialogPortal>
      {showOverlay && <DialogOverlay />}
      <DialogPrimitive.Popup ... />
    </DialogPortal>
  )
}
~~~

Add size helpers:

~~~ts
export const DEFAULT_FLOATING_CHAT_SIZE = { width: 380, height: 560 } as const
export const FLOATING_CHAT_SIZE_STORAGE_KEY = 'ediora.global-chat.panel-size.v1'

export type FloatingChatSize = { width: number; height: number }

export function clampFloatingChatSize(
  size: FloatingChatSize,
  viewport: { width: number; height: number },
): FloatingChatSize

export function readFloatingChatSize(
  storage: Storage | null,
  viewport: { width: number; height: number },
): FloatingChatSize

export function writeFloatingChatSize(
  storage: Storage | null,
  size: FloatingChatSize,
): void
~~~

Use minimums of 320px width and 420px height. The maximum width is the smaller of 720px and viewport width minus 32px; the maximum height is the smaller of 780px and viewport height minus 32px. Invalid JSON, non-numeric values, and out-of-range values must return the clamped default.

- [ ] **Step 1: Write failing Dialog and size tests**

Add:

~~~tsx
it('does not render an overlay when showOverlay is false', () => {
  render(
    <Dialog open>
      <DialogContent showOverlay={false}>content</DialogContent>
    </Dialog>,
  )

  expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeInTheDocument()
})
~~~

Add size tests for default values, narrow viewports, invalid storage, and persistence round-trip.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

~~~bash
cd web
pnpm exec vitest run components/ui/dialog.test.tsx \
  components/features/chat/floating-chat-size.test.ts
~~~

Expected: the overlay prop and size module tests fail.

- [ ] **Step 3: Write the minimal Dialog and size changes**

Keep DialogContent's default overlay behavior unchanged for all existing callers. Only the floating widget will pass showOverlay={false}. Implement clamping without accessing window at module evaluation time so tests and server rendering remain safe.

- [ ] **Step 4: Run the focused tests and the existing Dialog regression**

Run the same command. Expected: all selected tests pass.

- [ ] **Step 5: Commit the Dialog and size primitives**

~~~bash
git add web/components/ui/dialog.tsx web/components/ui/dialog.test.tsx \
  web/components/features/chat/floating-chat-size.ts \
  web/components/features/chat/floating-chat-size.test.ts
git commit -m "feat: add nonmodal floating chat primitives"
~~~

---

### Task 6: Implement GlobalChatWidget and root-layout integration

**Files:**
- Create: web/components/features/chat/GlobalChatWidget.tsx
- Create: web/components/features/chat/GlobalChatWidget.test.tsx
- Modify: web/app/layout.tsx

**Interfaces:**

~~~tsx
export function GlobalChatWidget(): JSX.Element
~~~

The widget must expose these stable test hooks:

- data-testid=global-chat-trigger;
- data-testid=global-chat-panel;
- data-testid=floating-chat-resize-handle;
- data-testid=floating-chat-reset-size.

- [ ] **Step 1: Write failing widget tests**

Cover:

~~~tsx
it('keeps the trigger visible before Chat data loads', () => {
  render(<GlobalChatWidget />)
  expect(screen.getByTestId('global-chat-trigger')).toBeInTheDocument()
})

it('opens a non-modal floating panel without an overlay', async () => {
  render(
    <ChatWorkspaceProvider>
      <GlobalChatWidget />
    </ChatWorkspaceProvider>,
  )

  await userEvent.click(screen.getByTestId('global-chat-trigger'))

  expect(await screen.findByTestId('global-chat-panel')).toBeInTheDocument()
  expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeInTheDocument()
})

it('restores and resets the persisted panel size', async () => {
  localStorage.setItem(
    FLOATING_CHAT_SIZE_STORAGE_KEY,
    JSON.stringify({ width: 500, height: 640 }),
  )
  render(
    <ChatWorkspaceProvider>
      <GlobalChatWidget />
    </ChatWorkspaceProvider>,
  )

  await userEvent.click(screen.getByTestId('global-chat-trigger'))

  expect(screen.getByTestId('global-chat-panel')).toHaveStyle({ width: '500px', height: '640px' })
  await userEvent.click(screen.getByTestId('floating-chat-reset-size'))
  expect(screen.getByTestId('global-chat-panel')).toHaveStyle({ width: '380px', height: '560px' })
})
~~~

Also test that a pointer resize clamps to the viewport and writes localStorage. Use a fake Provider fixture so the test does not depend on the API.

- [ ] **Step 2: Run the widget tests and verify they fail**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/GlobalChatWidget.test.tsx
~~~

Expected: FAIL because the widget is not defined.

- [ ] **Step 3: Write the minimal persistent floating widget**

Mount the widget inside ChatWorkspaceProvider in the root layout:

~~~tsx
<ThemeProvider>
  <ChatWorkspaceProvider>
    <AppShell sidebar={<Sidebar />}>{children}</AppShell>
    <GlobalChatWidget />
    <Toaster position="bottom-right" />
  </ChatWorkspaceProvider>
</ThemeProvider>
~~~

The widget must:

- render the fixed assistant trigger independently of sessions and network state;
- hold only open/closed and panel-size UI state;
- read size from localStorage in the client initializer or before first open, never during server module evaluation;
- render Dialog with modal={false}, showOverlay={false}, and a bottom-right class override;
- keep the Provider mounted while the panel is closed;
- use a pointer-capture resize handle to update width/height through clampFloatingChatSize;
- persist size on pointer release and expose a reset button;
- apply max-height/max-width constraints on viewport resize;
- keep the panel's message region and composer in a min-h-0 flex column;
- close on Escape and return focus to the trigger through the Dialog primitive.

Do not add a pathname check to hide the widget on /chat. Do not add route transition effects.

- [ ] **Step 4: Run widget, workspace, and layout-adjacent regressions**

Run:

~~~bash
cd web
pnpm exec vitest run components/features/chat/GlobalChatWidget.test.tsx \
  components/features/chat/ChatWorkspace.test.tsx \
  components/ui/dialog.test.tsx app/chat/ChatClient.test.tsx
~~~

Expected: all selected tests pass, including the existing page Chat behavior.

- [ ] **Step 5: Commit the root integration**

~~~bash
git add web/components/features/chat/GlobalChatWidget.tsx \
  web/components/features/chat/GlobalChatWidget.test.tsx \
  web/app/layout.tsx
git commit -m "feat: add global floating chat widget"
~~~

---

### Task 7: Verify the complete focused feature and clean up regressions

**Files:**
- Modify: only files identified by the focused test or lint output.
- Test: all new Chat workspace tests plus existing direct Chat tests.

**Interfaces:**

The final branch must expose:

- Root-level ChatWorkspaceProvider and GlobalChatWidget;
- /chat rendering ChatWorkspace variant page;
- floating ChatWorkspace variant floating;
- shared session pool and per-session running/message state;
- non-modal floating Dialog with persisted, clamped width/height.

- [ ] **Step 1: Run the complete focused frontend test set**

Run from web:

~~~bash
pnpm exec vitest run \
  components/features/chat/chat-workspace-state.test.ts \
  components/features/chat/ChatMessageView.test.tsx \
  components/features/chat/ChatWorkspaceProvider.test.tsx \
  components/features/chat/ChatWorkspace.test.tsx \
  components/features/chat/floating-chat-size.test.ts \
  components/features/chat/GlobalChatWidget.test.tsx \
  components/ui/dialog.test.tsx \
  app/chat/ChatClient.test.tsx \
  app/chat/ChatAgentLogDialog.test.tsx \
  lib/api/chat.test.ts
~~~

Expected: all selected files pass with zero failures.

- [ ] **Step 2: Run changed-file ESLint**

Run:

~~~bash
pnpm exec eslint \
  app/layout.tsx app/chat/ChatClient.tsx app/chat/ChatClient.test.tsx \
  app/chat/ChatAgentLogDialog.tsx \
  components/ui/dialog.tsx components/ui/dialog.test.tsx \
  components/features/chat
~~~

Expected: exit code 0 and no lint errors.

- [ ] **Step 3: Run TypeScript and whitespace checks**

Run:

~~~bash
pnpm exec tsc --noEmit --pretty false
git diff --check
~~~

Expected: TypeScript exits 0 and git diff --check prints no errors. If an unrelated pre-existing TypeScript error appears, record its exact file and message instead of claiming a clean type check.

- [ ] **Step 4: Inspect the final diff against the approved spec**

Check:

~~~bash
git status --short
  git diff --stat develop..HEAD
  git log --oneline --decorate -8
~~~

Confirm the diff contains no backend changes, no page-context collection, no panel dragging, no route-transition animation, and no duplicate Chat API implementation.

---

## Handoff

After each task commit, report the focused test command and result. Before opening a PR or merging into develop, run Task 7 and report tests, lint, typecheck, diff-check, and any environment blockers separately. Do not merge this branch or push it until the user explicitly requests the integration step.
