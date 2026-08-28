'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  createChatPipeline,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatDrafts,
  listChatSkills,
  listChatSessions,
  renameChatSession,
  streamChatReply,
  type ChatDraft,
  type ChatComposerMessagePart,
  type ChatSession,
  type ChatSkill,
  type SubmittedSkillInvocation,
} from '@/lib/api/chat'
import { ApiError } from '@/lib/api/client'
import { publishDraftArtifact } from '@/lib/events/draft-artifacts'
import type { PersistedArtifact } from '@/lib/ai/chat-run-types'
import { titleFromFirstMessage } from '@/app/chat/chat-title'

import {
  applyApprovalDecision,
  applyChatStreamEvent,
  initialChatStatusPart,
  makeLocalMessage,
  toModelMessages,
} from './chat-workspace-state'
import type {
  ChatApprovalArgs,
  ChatWorkspaceState,
  DisplayMessage,
} from './chat-workspace-types'

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
  submit: (text: string, messageParts: ChatComposerMessagePart[]) => Promise<boolean>
  respondToApproval: (args: ChatApprovalArgs) => Promise<void>
  setSkillName: (skillName: string) => void
  setDraftId: (draftId: number | null) => void
  setPipelineInvocations: (invocations: SubmittedSkillInvocation[]) => void
  retrySession: (sessionId: number) => Promise<void>
}

const ChatWorkspaceContext = createContext<ChatWorkspaceContextValue | null>(null)

function sessionKey(sessionId: number) {
  return String(sessionId)
}

function initialState(): ChatWorkspaceState {
  return {
    sessions: [],
    activeSessionId: null,
    messagesBySession: {},
    loadingBySession: {},
    runningBySession: {},
    errorsBySession: {},
    composer: {
      skillName: '',
      draftId: null,
      pipelineInvocations: [],
    },
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function isMissingSession(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404
}

function newClientMessageId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `chat-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function ChatWorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatWorkspaceState>(initialState)
  const [skills, setSkills] = useState<ChatSkill[]>([])
  const [drafts, setDrafts] = useState<ChatDraft[]>([])
  const loadedSessionsRef = useRef(new Set<number>())
  const sessionRequestsRef = useRef(new Map<number, Promise<void>>())
  const sessionsRequestRef = useRef<Promise<ChatSession[]> | null>(null)
  const resourcesRequestRef = useRef<Promise<void> | null>(null)
  const inlineStreamSessionIdsRef = useRef(new Set<number>())
  const pendingPipelineSubmissionRef = useRef<{
    signature: string
    clientMessageId: string
  } | null>(null)
  const approvalRequestsRef = useRef(new Set<string>())
  const publishedArtifactsRef = useRef(new Set<string>())

  const publishArtifactEvent = useCallback((event: UIMessageStreamEvent) => {
    if (event.type !== 'data-artifact' || !event.data || typeof event.data !== 'object') return
    const artifact = event.data as PersistedArtifact
    const artifactKey = `${artifact.kind}:${artifact.id}`
    if (publishedArtifactsRef.current.has(artifactKey)) return
    publishedArtifactsRef.current.add(artifactKey)
    publishDraftArtifact(artifact)
  }, [])

  const updateSession = useCallback((
    sessionId: number,
    update: (messages: DisplayMessage[]) => DisplayMessage[],
  ) => {
    const key = sessionKey(sessionId)
    setState(current => ({
      ...current,
      messagesBySession: {
        ...current.messagesBySession,
        [key]: update(current.messagesBySession[key] ?? []),
      },
    }))
  }, [])

  const setSessionDetail = useCallback((session: Awaited<ReturnType<typeof getChatSession>>) => {
    const key = sessionKey(session.id)
    loadedSessionsRef.current.add(session.id)
    setState(current => ({
      ...current,
      messagesBySession: {
        ...current.messagesBySession,
        [key]: session.messages,
      },
      loadingBySession: {
        ...current.loadingBySession,
        [key]: false,
      },
      runningBySession: {
        ...current.runningBySession,
        [key]: session.is_running,
      },
      errorsBySession: {
        ...current.errorsBySession,
        [key]: null,
      },
    }))
  }, [])

  const setSessionError = useCallback((sessionId: number, error: string | null) => {
    const key = sessionKey(sessionId)
    setState(current => ({
      ...current,
      loadingBySession: {
        ...current.loadingBySession,
        [key]: false,
      },
      errorsBySession: {
        ...current.errorsBySession,
        [key]: error,
      },
    }))
  }, [])

  const setSessionRunning = useCallback((sessionId: number, running: boolean) => {
    const key = sessionKey(sessionId)
    setState(current => ({
      ...current,
      runningBySession: {
        ...current.runningBySession,
        [key]: running,
      },
    }))
  }, [])

  const forgetSession = useCallback((sessionId: number) => {
    loadedSessionsRef.current.delete(sessionId)
    const key = sessionKey(sessionId)
    setState(current => {
      const sessions = current.sessions.filter(session => session.id !== sessionId)
      const messagesBySession = { ...current.messagesBySession }
      const loadingBySession = { ...current.loadingBySession }
      const runningBySession = { ...current.runningBySession }
      const errorsBySession = { ...current.errorsBySession }
      delete messagesBySession[key]
      delete loadingBySession[key]
      delete runningBySession[key]
      delete errorsBySession[key]
      return {
        ...current,
        sessions,
        activeSessionId: current.activeSessionId === sessionId
          ? (sessions[0]?.id ?? null)
          : current.activeSessionId,
        messagesBySession,
        loadingBySession,
        runningBySession,
        errorsBySession,
      }
    })
  }, [])

  const loadResources = useCallback(() => {
    if (resourcesRequestRef.current) return resourcesRequestRef.current
    const request = Promise.all([listChatSkills(), listChatDrafts()])
      .then(([nextSkills, nextDrafts]) => {
        setSkills(nextSkills)
        setDrafts(nextDrafts)
      })
      .finally(() => {
        resourcesRequestRef.current = null
      })
    resourcesRequestRef.current = request
    return request
  }, [])

  const refreshSessions = useCallback(() => {
    if (sessionsRequestRef.current) return sessionsRequestRef.current
    const request = Promise.all([listChatSessions(), loadResources()])
      .then(([sessions]) => {
        setState(current => ({ ...current, sessions }))
        return sessions
      })
      .finally(() => {
        sessionsRequestRef.current = null
      })
    sessionsRequestRef.current = request
    return request
  }, [loadResources])

  const loadSession = useCallback(async (sessionId: number, force = false) => {
    if (!force && loadedSessionsRef.current.has(sessionId)) return
    const activeRequest = sessionRequestsRef.current.get(sessionId)
    if (activeRequest) return activeRequest

    const key = sessionKey(sessionId)
    setState(current => ({
      ...current,
      loadingBySession: {
        ...current.loadingBySession,
        [key]: true,
      },
      errorsBySession: {
        ...current.errorsBySession,
        [key]: null,
      },
    }))

    const request = getChatSession(sessionId)
      .then(session => {
        setSessionDetail(session)
      })
      .catch(error => {
        if (isMissingSession(error)) {
          forgetSession(sessionId)
          throw error
        }
        setSessionError(sessionId, errorMessage(error, '加载会话失败'))
        throw error
      })
      .finally(() => {
        sessionRequestsRef.current.delete(sessionId)
      })
    sessionRequestsRef.current.set(sessionId, request)
    return request
  }, [forgetSession, setSessionDetail, setSessionError])

  const openSession = useCallback(async (sessionId: number) => {
    setState(current => ({
      ...current,
      activeSessionId: sessionId,
      composer: { ...current.composer, pipelineInvocations: [] },
    }))
    await loadSession(sessionId)
  }, [loadSession])

  const startNewConversation = useCallback(() => {
    setState(current => ({
      ...current,
      activeSessionId: null,
      composer: { skillName: '', draftId: null, pipelineInvocations: [] },
    }))
  }, [])

  const renameSession = useCallback(async (sessionId: number, title: string) => {
    const updated = await renameChatSession(sessionId, title.trim() || '新对话')
    setState(current => ({
      ...current,
      sessions: current.sessions.map(session => session.id === updated.id ? updated : session),
    }))
  }, [])

  const removeSession = useCallback(async (sessionId: number) => {
    await deleteChatSession(sessionId)
    loadedSessionsRef.current.delete(sessionId)
    const key = sessionKey(sessionId)
    setState(current => {
      const remaining = current.sessions.filter(session => session.id !== sessionId)
      const nextActive = current.activeSessionId === sessionId
        ? (remaining[0]?.id ?? null)
        : current.activeSessionId
      const messagesBySession = { ...current.messagesBySession }
      const loadingBySession = { ...current.loadingBySession }
      const runningBySession = { ...current.runningBySession }
      const errorsBySession = { ...current.errorsBySession }
      delete messagesBySession[key]
      delete loadingBySession[key]
      delete runningBySession[key]
      delete errorsBySession[key]
      return {
        ...current,
        sessions: remaining,
        activeSessionId: nextActive,
        messagesBySession,
        loadingBySession,
        runningBySession,
        errorsBySession,
      }
    })
    const nextSession = state.sessions.find(session => session.id !== sessionId)
    if (state.activeSessionId === sessionId && nextSession) {
      await loadSession(nextSession.id)
    }
  }, [loadSession, state.activeSessionId, state.sessions])

  const ensureActiveSession = useCallback(async (text: string) => {
    if (state.activeSessionId !== null) return state.activeSessionId
    const session = await createChatSession(titleFromFirstMessage(text))
    loadedSessionsRef.current.add(session.id)
    setState(current => ({
      ...current,
      sessions: [session, ...current.sessions.filter(item => item.id !== session.id)],
      activeSessionId: session.id,
      messagesBySession: {
        ...current.messagesBySession,
        [sessionKey(session.id)]: [],
      },
      loadingBySession: {
        ...current.loadingBySession,
        [sessionKey(session.id)]: false,
      },
      errorsBySession: {
        ...current.errorsBySession,
        [sessionKey(session.id)]: null,
      },
    }))
    return session.id
  }, [state.activeSessionId])

  const submit = useCallback(async (text: string, messageParts: ChatComposerMessagePart[]) => {
    const trimmed = text.trim()
    if (!trimmed) return false
    const sessionId = await ensureActiveSession(trimmed)
    const key = sessionKey(sessionId)
    if (state.runningBySession[key]) return false

    const pipelineInvocations = state.composer.pipelineInvocations
    if (pipelineInvocations.length >= 2) {
      const signature = JSON.stringify({ sessionId, objective: trimmed, pipelineInvocations, messageParts })
      const clientMessageId = pendingPipelineSubmissionRef.current?.signature === signature
        ? pendingPipelineSubmissionRef.current.clientMessageId
        : newClientMessageId()
      pendingPipelineSubmissionRef.current = { signature, clientMessageId }
      setSessionRunning(sessionId, true)
      setSessionError(sessionId, null)
      try {
        await createChatPipeline(sessionId, {
          clientMessageId,
          objective: trimmed,
          title: titleFromFirstMessage(trimmed),
          invocations: pipelineInvocations,
          messageParts,
        })
        await loadSession(sessionId, true)
        await refreshSessions()
        setState(current => ({
          ...current,
          composer: { ...current.composer, pipelineInvocations: [] },
        }))
        pendingPipelineSubmissionRef.current = null
        return true
      } catch (error) {
        setSessionError(sessionId, errorMessage(error, '创建 Skill Pipeline 失败'))
        return false
      } finally {
        setSessionRunning(sessionId, false)
      }
    }

    const currentMessages = state.messagesBySession[key] ?? []
    const directInvocation = pipelineInvocations.length === 1
      ? pipelineInvocations[0]
      : undefined
    const userMessage = makeLocalMessage('user', messageParts)
    const assistantMessage = makeLocalMessage('assistant', [initialChatStatusPart()])
    const requestMessages = toModelMessages([...currentMessages, userMessage])
    updateSession(sessionId, messages => [...messages, userMessage, assistantMessage])
    inlineStreamSessionIdsRef.current.add(sessionId)
    setSessionRunning(sessionId, true)
    setSessionError(sessionId, null)

    try {
      await streamChatReply({
        sessionId,
        messages: requestMessages,
        skillName: state.composer.skillName || undefined,
        draftId: state.composer.draftId ?? undefined,
        skillInvocation: directInvocation,
        messageParts: directInvocation ? messageParts : undefined,
        onEvent: event => {
          publishArtifactEvent(event)
          updateSession(
            sessionId,
            messages => applyChatStreamEvent(messages, String(assistantMessage.id), event),
          )
        },
      })
      await loadSession(sessionId, true)
      await refreshSessions()
      if (directInvocation) {
        setState(current => ({
          ...current,
          composer: { ...current.composer, pipelineInvocations: [] },
        }))
      }
      return true
    } catch (error) {
      setSessionError(sessionId, errorMessage(error, '发送消息失败'))
      return false
    } finally {
      inlineStreamSessionIdsRef.current.delete(sessionId)
      setSessionRunning(sessionId, false)
    }
  }, [
    ensureActiveSession,
    loadSession,
    publishArtifactEvent,
    refreshSessions,
    setSessionError,
    setSessionRunning,
    state.composer,
    state.messagesBySession,
    state.runningBySession,
    updateSession,
  ])

  const respondToApproval = useCallback(async (args: ChatApprovalArgs) => {
    const key = sessionKey(args.sessionId)
    const requestKey = `${args.runId}:${args.toolCallId}:${args.approvalId}`
    if (state.runningBySession[key] || approvalRequestsRef.current.has(requestKey)) return
    const assistantMessage = (state.messagesBySession[key] ?? []).find(message => (
      message.run_id === args.runId
      || message.parts.some(part => part.runId === args.runId)
    ))
    if (!assistantMessage) {
      setSessionError(args.sessionId, '该任务的运行状态不可用，请重新开始')
      return
    }
    approvalRequestsRef.current.add(requestKey)
    updateSession(args.sessionId, messages => applyApprovalDecision(messages, args))
    inlineStreamSessionIdsRef.current.add(args.sessionId)
    setSessionRunning(args.sessionId, true)
    setSessionError(args.sessionId, null)
    try {
      await streamChatReply({
        sessionId: args.sessionId,
        messages: [],
        approval: {
          runId: args.runId,
          toolCallId: args.toolCallId,
          approvalId: args.approvalId,
          approved: args.approved,
          ...(args.reason ? { reason: args.reason } : {}),
        },
        onEvent: event => {
          publishArtifactEvent(event)
          updateSession(
            args.sessionId,
            messages => applyChatStreamEvent(messages, String(assistantMessage.id), event),
          )
        },
      })
      await loadSession(args.sessionId, true)
      await refreshSessions()
    } catch (error) {
      try {
        await loadSession(args.sessionId, true)
      } catch {
        // Keep the optimistic decision if the authoritative session is temporarily unavailable.
      }
      setSessionError(args.sessionId, errorMessage(error, '处理工具确认失败'))
    } finally {
      approvalRequestsRef.current.delete(requestKey)
      inlineStreamSessionIdsRef.current.delete(args.sessionId)
      setSessionRunning(args.sessionId, false)
    }
  }, [
    loadSession,
    publishArtifactEvent,
    refreshSessions,
    setSessionError,
    setSessionRunning,
    state.messagesBySession,
    state.runningBySession,
    updateSession,
  ])

  const retrySession = useCallback(async (sessionId: number) => {
    setSessionError(sessionId, null)
    await loadSession(sessionId, true)
  }, [loadSession, setSessionError])

  useEffect(() => {
    const runningIds = Object.entries(state.runningBySession)
      .filter(([, running]) => running)
      .map(([id]) => Number(id))
    if (runningIds.length === 0) return

    const refreshRunningSessions = async () => {
      await Promise.all(runningIds.map(async sessionId => {
        if (inlineStreamSessionIdsRef.current.has(sessionId)) return
        try {
          const session = await getChatSession(sessionId)
          setSessionDetail(session)
        } catch (error) {
          if (isMissingSession(error)) {
            const nextSession = state.activeSessionId === sessionId
              ? state.sessions.find(session => session.id !== sessionId)
              : undefined
            forgetSession(sessionId)
            if (nextSession) void loadSession(nextSession.id, true)
            return
          }
          // Keep transient failures retryable without hiding the running state.
        }
      }))
    }

    const timer = window.setInterval(() => void refreshRunningSessions(), 2_000)
    return () => window.clearInterval(timer)
  }, [forgetSession, loadSession, setSessionDetail, state.activeSessionId, state.runningBySession, state.sessions])

  const activeKey = state.activeSessionId === null ? null : sessionKey(state.activeSessionId)
  const context = useMemo<ChatWorkspaceContextValue>(() => ({
    state,
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    messages: activeKey ? state.messagesBySession[activeKey] ?? [] : [],
    isActiveLoading: activeKey ? Boolean(state.loadingBySession[activeKey]) : false,
    isActiveRunning: activeKey ? Boolean(state.runningBySession[activeKey]) : false,
    activeError: activeKey ? state.errorsBySession[activeKey] ?? null : null,
    skills,
    drafts,
    refreshSessions,
    openSession,
    startNewConversation,
    renameSession,
    removeSession,
    submit,
    respondToApproval,
    setSkillName: skillName => setState(current => ({
      ...current,
      composer: { ...current.composer, skillName },
    })),
    setDraftId: draftId => setState(current => ({
      ...current,
      composer: { ...current.composer, draftId },
    })),
    setPipelineInvocations: pipelineInvocations => setState(current => ({
      ...current,
      composer: { ...current.composer, pipelineInvocations },
    })),
    retrySession,
  }), [
    activeKey,
    drafts,
    openSession,
    refreshSessions,
    removeSession,
    renameSession,
    respondToApproval,
    retrySession,
    skills,
    startNewConversation,
    state,
    submit,
  ])

  return <ChatWorkspaceContext.Provider value={context}>{children}</ChatWorkspaceContext.Provider>
}

export function useChatWorkspace() {
  const context = useContext(ChatWorkspaceContext)
  if (!context) throw new Error('useChatWorkspace must be used within ChatWorkspaceProvider')
  return context
}
