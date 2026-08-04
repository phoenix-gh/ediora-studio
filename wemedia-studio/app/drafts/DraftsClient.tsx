'use client'

import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import {
  BookMarked, Trash2, Save, RefreshCw, FileText, Clock,
  ChevronRight, Loader2, Plus,
  Link2, MessageSquare, Send, CheckCheck,
  Images, GitBranch,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  Draft, DraftSource, DraftUpdate, ChatMessage, DraftImage,
  DRAFT_STATUSES, draftTypeInfo,
  getDrafts, updateDraft, deleteDraft, createDraft, chatWithDraft,
  getDraftImages, uploadDraftImage, deleteDraftImage,
} from '@/lib/api/drafts'
import { WritingPlan, getWritingPlans, flattenTopicsWithDepth } from '@/lib/api/writing-plans'
import { illustrateBody, regenerateCover } from '@/lib/api/studio'
import { MarkdownEditor, MarkdownEditorHandle } from './MarkdownEditor'
import { PublishDialog } from './PublishDialog'
import { DraftAssetsDialog } from '@/components/features/DraftAssetsDialog'
import {
  BulkImageActionDialog,
  type BulkImageMode,
  type BulkImageOptions,
} from './BulkImageActionDialog'
import { runBulkOperations } from './draft-bulk-operations'
import '@uiw/react-md-editor/markdown-editor.css'

function draftMatchesFilters(draft: Draft, status: string, topicId: string) {
  if (status !== 'all' && draft.status !== status) return false
  if (topicId !== 'all') {
    const expectedTopicId = topicId === 'none' ? null : Number(topicId)
    if (draft.writing_plan_id !== expectedTopicId) return false
  }
  return true
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  drafting:  'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  editing:   'bg-blue-100 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400',
  ready:     'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400',
  published: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400',
  archived:  'bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400',
}

function statusLabel(v: string) {
  return DRAFT_STATUSES.find(s => s.value === v)?.label ?? v
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// ── Main Component ─────────────────────────────────────────────────────────────

const subscribeToHydration = () => () => {}
const getHydratedClientSnapshot = () => true
const getHydratedServerSnapshot = () => false
const emptyStoredChat = {
  history: [] as ChatMessage[],
  sessionName: null as string | null,
  pending: null as string | null,
}

function chatStorageKey(draftId: number) {
  return `wms-chat-${draftId}`
}

function saveChatToStorage(
  draftId: number,
  history: ChatMessage[],
  sessionName: string | null,
  pending: string | null,
) {
  try {
    localStorage.setItem(
      chatStorageKey(draftId),
      JSON.stringify({ history, sessionName, pending }),
    )
  } catch {}
}

function loadChatFromStorage(draftId: number): {
  history: ChatMessage[]
  sessionName: string | null
  pending: string | null
} {
  if (typeof localStorage === 'undefined') {
    return { history: [], sessionName: null, pending: null }
  }
  try {
    const raw = localStorage.getItem(chatStorageKey(draftId))
    if (raw) return JSON.parse(raw)
  } catch {}
  return { history: [], sessionName: null, pending: null }
}

export function DraftsClient({
  initialDrafts,
  initialTopics,
  initialDraftId,
  initialChatOpen = false,
}: {
  initialDrafts: Draft[]
  initialTopics: WritingPlan[]
  initialDraftId?: number
  initialChatOpen?: boolean
}) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts)
  const [topicList, setTopicList] = useState<WritingPlan[]>(initialTopics)

  const initialDraft = initialDraftId
    ? (initialDrafts.find(d => d.id === initialDraftId) ?? initialDrafts[0] ?? null)
    : (initialDrafts[0] ?? null)

  const [selected, setSelected] = useState<Draft | null>(initialDraft)
  const selectedDraftIdRef = useRef<number | null>(initialDraft?.id ?? null)
  const selectionIdentityRef = useRef(0)

  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterTopicId, setFilterTopicId] = useState<string>('all')
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<number>>(() => new Set())
  const [bulkMode, setBulkMode] = useState<BulkImageMode | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ completed: 0, total: 0 })
  const [bulkFailures, setBulkFailures] = useState<Array<{ title: string; reason?: string }>>([])

  // Editor state
  const [editTitle, setEditTitle] = useState(selected?.title ?? '')
  const [editContent, setEditContent] = useState(selected?.content ?? '')
  const [editStatus, setEditStatus] = useState(selected?.status ?? 'drafting')
  const [editWritingPlanId, setEditWritingPlanId] = useState<number | null>(selected?.writing_plan_id ?? null)
  const [editSources, setEditSources] = useState<DraftSource[]>(selected?.sources ?? [])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Chat state
  const [chatOpen, setChatOpen] = useState(initialChatOpen)
  const [publishOpen, setPublishOpen] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [assetsTab, setAssetsTab] = useState<'sources' | 'images'>('sources')
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedClientSnapshot,
    getHydratedServerSnapshot,
  )
  const storedInitialChat = hydrated && initialDraft
    ? loadChatFromStorage(initialDraft.id)
    : emptyStoredChat
  const [chatState, setChatState] = useState<typeof emptyStoredChat | null>(null)
  const chatHistory = chatState ? chatState.history : storedInitialChat.history
  const chatSessionName = chatState ? chatState.sessionName : storedInitialChat.sessionName
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const pendingContent = chatState ? chatState.pending : storedInitialChat.pending
  const chatSnapshotRef = useRef({
    history: chatHistory,
    sessionName: chatSessionName,
    pending: pendingContent,
  })
  const chatEndRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)

  // Image library state
  const [images, setImages] = useState<DraftImage[]>([])
  const [imagesLoading, setImagesLoading] = useState(initialDraft !== null)
  const [initialImageDraftId] = useState(() => initialDraft?.id ?? null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)

  function setChatHistory(history: ChatMessage[]) {
    chatSnapshotRef.current = { ...chatSnapshotRef.current, history }
    setChatState(current => ({ ...(current ?? storedInitialChat), history }))
  }

  function setChatSessionName(sessionName: string | null) {
    chatSnapshotRef.current = { ...chatSnapshotRef.current, sessionName }
    setChatState(current => ({ ...(current ?? storedInitialChat), sessionName }))
  }

  function setPendingContent(pending: string | null) {
    chatSnapshotRef.current = { ...chatSnapshotRef.current, pending }
    setChatState(current => ({ ...(current ?? storedInitialChat), pending }))
  }

  useEffect(() => {
    chatSnapshotRef.current = {
      history: chatHistory,
      sessionName: chatSessionName,
      pending: pendingContent,
    }
  }, [chatHistory, chatSessionName, pendingContent])

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    danger: boolean
    onConfirm: () => void
  }>({ open: false, title: '', description: '', confirmLabel: '确定', danger: false, onConfirm: () => {} })

  function openConfirm(opts: { title: string; description: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) {
    setConfirmDialog({ open: true, confirmLabel: '确定', danger: false, ...opts })
  }
  function closeConfirm() { setConfirmDialog(d => ({ ...d, open: false })) }

  const wordCount = useMemo(() =>
    editContent
      .replace(/```[\s\S]*?```/g, '')   // fenced code blocks
      .replace(/`[^`\n]*`/g, '')         // inline code
      .replace(/\s/g, '')                // whitespace
      .length
  , [editContent])

  // Load the initial draft's image library. Later draft changes load from
  // activateDraft(), where the user action also resets the editor state.
  useEffect(() => {
    if (initialImageDraftId === null) return
    let cancelled = false
    const requestedDraftId = selectedDraftIdRef.current
    const requestedSelectionIdentity = selectionIdentityRef.current
    void getDraftImages(initialImageDraftId)
      .then(items => {
        if (
          !cancelled
          && selectedDraftIdRef.current === requestedDraftId
          && selectionIdentityRef.current === requestedSelectionIdentity
        ) {
          setImages(items)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (
          !cancelled
          && selectedDraftIdRef.current === requestedDraftId
          && selectionIdentityRef.current === requestedSelectionIdentity
        ) {
          setImagesLoading(false)
        }
    })
    return () => { cancelled = true }
  }, [initialImageDraftId])

  useEffect(() => { getWritingPlans().then(t => setTopicList(t)).catch(() => {}) }, [])

  // ── Filtering ──────────────────────────────────────────────────────────────

  const filteredDrafts = useMemo(
    () => drafts.filter(draft => draftMatchesFilters(draft, filterStatus, filterTopicId)),
    [drafts, filterStatus, filterTopicId],
  )
  const visibleDraftIds = useMemo(
    () => new Set(filteredDrafts.map(draft => draft.id)),
    [filteredDrafts],
  )

  // ── Handlers ───────────────────────────────────────────────────────────────

  function applyFilters(nextStatus: string, nextTopicId: string) {
    const nextVisibleIds = new Set(
      drafts
        .filter(draft => draftMatchesFilters(draft, nextStatus, nextTopicId))
        .map(draft => draft.id),
    )
    setSelectedDraftIds(current => new Set([...current].filter(id => nextVisibleIds.has(id))))
  }

  function changeStatusFilter(nextStatus: string) {
    setFilterStatus(nextStatus)
    applyFilters(nextStatus, filterTopicId)
  }

  function changeTopicFilter(nextTopicId: string) {
    setFilterTopicId(nextTopicId)
    applyFilters(filterStatus, nextTopicId)
  }

  function activateDraft(next: Draft | null) {
    const outgoingDraftId = selectedDraftIdRef.current
    if (outgoingDraftId !== null) {
      const latestChat = chatSnapshotRef.current
      saveChatToStorage(
        outgoingDraftId,
        latestChat.history,
        latestChat.sessionName,
        latestChat.pending,
      )
    }
    const selectionIdentity = selectionIdentityRef.current + 1
    selectionIdentityRef.current = selectionIdentity
    selectedDraftIdRef.current = next?.id ?? null
    setSelected(next)
    setSaving(false)
    if (!next) {
      setImages([])
      setImagesLoading(false)
      return
    }

    setEditTitle(next.title)
    setEditContent(next.content)
    setEditStatus(next.status)
    setEditWritingPlanId(next.writing_plan_id ?? null)
    setEditSources(next.sources ?? [])
    const saved = loadChatFromStorage(next.id)
    setChatHistory(saved.history)
    setChatSessionName(saved.sessionName)
    setPendingContent(saved.pending)
    setDirty(false)
    setImages([])
    setImagesLoading(true)
    void getDraftImages(next.id)
      .then(items => {
        if (selectionIdentityRef.current === selectionIdentity) setImages(items)
      })
      .catch(() => {})
      .finally(() => {
        if (selectionIdentityRef.current === selectionIdentity) setImagesLoading(false)
      })
  }

  function toggleDraftSelection(draftId: number) {
    setSelectedDraftIds(current => {
      const next = new Set(current)
      if (next.has(draftId)) next.delete(draftId)
      else next.add(draftId)
      return next
    })
  }

  function openBulkImageDialog(mode: BulkImageMode) {
    setBulkMode(mode)
    setBulkProgress({ completed: 0, total: selectedDraftIds.size })
    setBulkFailures([])
  }

  async function handleBulkImageSubmit(options: BulkImageOptions) {
    if (bulkRunning) return
    const selectedDrafts = filteredDrafts.filter(draft => selectedDraftIds.has(draft.id))
    setBulkRunning(true)
    setBulkProgress({ completed: 0, total: selectedDrafts.length })
    setBulkFailures([])
    try {
      const results = await runBulkOperations(
        selectedDrafts,
        async draft => {
          if (options.mode === 'cover') {
            await regenerateCover({
              draft_id: draft.id,
              account_id: options.accountId,
              note: options.note,
              cover_style: options.coverStyle,
            })
            return
          }
          await illustrateBody({
            draft_id: draft.id,
            account_id: options.accountId,
            note: options.note,
            max_images: options.maxImages,
          })
        },
        (completed, total) => setBulkProgress({ completed, total }),
        3,
      )
      const fulfilledIds = new Set(
        results.filter(result => result.status === 'fulfilled').map(result => result.draftId),
      )
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => ({ title: result.title, reason: result.reason }))
      setSelectedDraftIds(current => {
        const next = new Set(current)
        fulfilledIds.forEach(id => next.delete(id))
        return next
      })
      setBulkFailures(failures)
      const message = `批量任务已提交：成功 ${fulfilledIds.size}，失败 ${failures.length}`
      if (failures.length > 0) toast.error(message)
      else {
        toast.success(message)
        setBulkMode(null)
      }
    } finally {
      setBulkRunning(false)
    }
  }

  function handleBulkDelete() {
    const count = selectedDraftIds.size
    if (count === 0 || bulkRunning) return
    openConfirm({
      title: '批量删除',
      description: `确定删除已选 ${count} 篇草稿？此操作不可恢复。`,
      confirmLabel: '确认删除',
      danger: true,
      onConfirm: () => { void doBulkDelete() },
    })
  }

  async function doBulkDelete() {
    if (bulkRunning) return
    const selectedDrafts = filteredDrafts.filter(draft => selectedDraftIds.has(draft.id))
    setBulkRunning(true)
    setBulkProgress({ completed: 0, total: selectedDrafts.length })
    try {
      const results = await runBulkOperations(
        selectedDrafts,
        draft => deleteDraft(draft.id),
        (completed, total) => setBulkProgress({ completed, total }),
        3,
      )
      const fresh = await getDrafts()
      const freshDraftIds = new Set(fresh.map(draft => draft.id))
      const rejectedIds = new Set(
        results.filter(result => result.status === 'rejected').map(result => result.draftId),
      )
      setDrafts(fresh)
      setSelectedDraftIds(new Set([...rejectedIds].filter(id => freshDraftIds.has(id))))

      const activeId = selectedDraftIdRef.current
      const refreshedActive = activeId === null ? null : fresh.find(draft => draft.id === activeId) ?? null
      if (refreshedActive) setSelected(refreshedActive)
      else activateDraft(fresh[0] ?? null)

      const succeeded = results.filter(result => result.status === 'fulfilled').length
      const failed = results.length - succeeded
      const message = `批量删除完成：成功 ${succeeded}，失败 ${failed}`
      if (failed > 0) toast.error(message)
      else toast.success(message)
    } catch {
      toast.error('批量删除后刷新失败')
    } finally {
      setBulkRunning(false)
    }
  }

  function handleSelectDraft(draft: Draft) {
    if (dirty) {
      openConfirm({
        title: '有未保存的修改',
        description: '切换草稿后当前修改将丢失，确定继续？',
        confirmLabel: '放弃修改',
        danger: true,
        onConfirm: () => activateDraft(draft),
      })
      return
    }
    activateDraft(draft)
  }

  async function handleSave() {
    if (!selected) return
    const requestedDraftId = selected.id
    const requestedSelectionIdentity = selectionIdentityRef.current
    setSaving(true)
    try {
      const body: DraftUpdate = {}
      if (editTitle !== selected.title) body.title = editTitle
      if (editContent !== selected.content) body.content = editContent
      if (editStatus !== selected.status) body.status = editStatus
      if (editWritingPlanId !== (selected.writing_plan_id ?? null)) body.writing_plan_id = editWritingPlanId
      if (JSON.stringify(editSources) !== JSON.stringify(selected.sources ?? [])) body.sources = editSources
      const updated = await updateDraft(selected.id, body)
      setDrafts(ds => ds.map(d => d.id === updated.id ? updated : d))
      if (
        selectedDraftIdRef.current === requestedDraftId
        && selectionIdentityRef.current === requestedSelectionIdentity
      ) {
        activateDraft(updated)
      }
      toast.success('已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      if (
        selectedDraftIdRef.current === requestedDraftId
        && selectionIdentityRef.current === requestedSelectionIdentity
      ) {
        setSaving(false)
      }
    }
  }

  // Ctrl/Cmd + S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (dirty) void handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dirty, handleSave])

  async function handleDelete() {
    if (!selected) return
    openConfirm({
      title: '删除草稿',
      description: `确定删除「${selected.title || draftTypeInfo(selected.draft_type).label + '稿'}」？此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => doDelete(),
    })
  }

  async function doDelete() {
    if (!selected) return
    setDeleting(true)
    try {
      await deleteDraft(selected.id)
      const nextDrafts = drafts.filter(d => d.id !== selected.id)
      setDrafts(nextDrafts)
      activateDraft(nextDrafts[0] ?? null)
      toast.success('已删除')
    } catch {
      toast.error('删除失败')
    } finally {
      setDeleting(false)
    }
  }

  async function handleCreateDraft() {
    setCreating(true)
    try {
      const draft = await createDraft({ title: '', content: '', draft_type: 'article', status: 'drafting' })
      const fresh = await getDrafts()
      setDrafts(fresh)
      if (fresh.some(item => item.id === draft.id)) {
        activateDraft(draft)
      }
      toast.success('已新建草稿')
    } catch {
      toast.error('新建失败')
    } finally {
      setCreating(false)
    }
  }

  async function handleRefresh() {
    const requestedDraftId = selectedDraftIdRef.current
    const requestedSelectionIdentity = selectionIdentityRef.current
    setRefreshing(true)
    try {
      const fresh = await getDrafts()
      setDrafts(fresh)
      if (
        requestedDraftId !== null
        && selectedDraftIdRef.current === requestedDraftId
        && selectionIdentityRef.current === requestedSelectionIdentity
      ) {
        const refreshed = fresh.find(d => d.id === requestedDraftId)
        if (refreshed) activateDraft(refreshed)
      }
    } catch {
      toast.error('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleChatSend() {
    if (!selected || !chatInput.trim() || chatLoading) return
    const userMsg: ChatMessage = { role: 'user', content: chatInput.trim() }
    const nextHistory = [...chatHistory, userMsg]
    setChatHistory(nextHistory)
    setChatInput('')
    setChatLoading(true)
    setPendingContent(null)
    try {
      const res = await chatWithDraft(selected.id, userMsg.content, {
        sessionName: chatSessionName ?? undefined,
        history: chatHistory,
      })
      const sessionName = res.session_name && !chatSessionName ? res.session_name : chatSessionName
      if (res.session_name && !chatSessionName) setChatSessionName(res.session_name)
      const assistantMsg: ChatMessage = { role: 'assistant', content: res.reply }
      const finalHistory = [...nextHistory, assistantMsg]
      setChatHistory(finalHistory)
      const pending = res.updated_content ?? null
      if (pending) setPendingContent(pending)
      saveChatToStorage(selected.id, finalHistory, sessionName, pending)
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch {
      toast.error('AI 回复失败')
    } finally {
      setChatLoading(false)
    }
  }

  async function handleImageUpload(files: FileList | null) {
    if (!selected || !files || files.length === 0) return
    setUploadingImage(true)
    try {
      const uploaded: DraftImage[] = []
      for (const file of Array.from(files)) {
        const img = await uploadDraftImage(selected.id, file)
        uploaded.push(img)
      }
      setImages(prev => [...uploaded, ...prev])
      toast.success(`已上传 ${uploaded.length} 张图片`)
    } catch {
      toast.error('图片上传失败')
    } finally {
      setUploadingImage(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  async function handleImageDelete(imageId: number) {
    if (!selected) return
    try {
      await deleteDraftImage(selected.id, imageId)
      setImages(prev => prev.filter(img => img.id !== imageId))
      toast.success('已删除')
    } catch {
      toast.error('删除失败')
    }
  }

  function handleInsertImage(img: DraftImage) {
    const markdown = `![${img.original_name || '图片'}](${img.hosted_url})`
    if (editorRef.current) {
      editorRef.current.insert(markdown)
    } else {
      setEditContent(v => v + '\n' + markdown)
      setDirty(true)
    }
  }

  function handleNewChatSession(event: React.MouseEvent<HTMLButtonElement>) {
    const newSession = `wms-draft-${selected?.id}-${event.timeStamp.toString(36)}`
    setChatHistory([])
    setPendingContent(null)
    setChatSessionName(newSession)
    if (selected) saveChatToStorage(selected.id, [], newSession, null)
    toast.success('已开启新对话')
  }

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left sidebar ───────────────────────────────────── */}
      <aside className="w-72 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
        {/* Header */}
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <BookMarked className="w-4 h-4 text-indigo-500" />
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">草稿箱</span>
          <span className="ml-auto text-xs text-zinc-400">{drafts.length} 篇</span>
          <button
            onClick={handleCreateDraft}
            disabled={creating}
            title="新建草稿"
            className="text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-400 disabled:opacity-40 transition-colors"
          >
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          </button>
          <button onClick={handleRefresh} disabled={refreshing} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40">
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>

        {/* Filters */}
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 flex gap-2">
          <select
            aria-label="按主题筛选"
            value={filterTopicId}
            onChange={e => changeTopicFilter(e.target.value)}
            className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 outline-none focus:border-indigo-400 cursor-pointer min-w-0 truncate"
          >
            <option value="all">全部主题</option>
            <option value="none">无主题</option>
            {flattenTopicsWithDepth(topicList).map(({ plan, label }) => (
              <option key={plan.id} value={String(plan.id)}>{label}</option>
            ))}
          </select>
          <select
            aria-label="按状态筛选"
            value={filterStatus}
            onChange={e => changeStatusFilter(e.target.value)}
            className="text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 outline-none focus:border-indigo-400 cursor-pointer"
          >
            <option value="all">全部状态</option>
            {DRAFT_STATUSES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {filteredDrafts.length > 0 ? (
          <div className="flex flex-col gap-1 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setSelectedDraftIds(new Set(visibleDraftIds))}
                disabled={bulkRunning}
              >
                全选当前结果
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">已选 {selectedDraftIds.size} 篇</span>
              {selectedDraftIds.size > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setSelectedDraftIds(new Set())}
                  disabled={bulkRunning}
                >
                  取消选择
                </Button>
              ) : null}
            </div>
            {selectedDraftIds.size > 0 ? (
              <div className="flex gap-1">
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={handleBulkDelete}
                  disabled={bulkRunning}
                >
                  批量删除
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => openBulkImageDialog('cover')}
                  disabled={bulkRunning}
                >
                  批量封面
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => openBulkImageDialog('illustrations')}
                  disabled={bulkRunning}
                >
                  批量插图
                </Button>
                {bulkRunning && bulkMode === null ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {bulkProgress.completed} / {bulkProgress.total}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Draft list */}
        <div className="flex-1 overflow-y-auto">
          {filteredDrafts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
              <FileText className="w-8 h-8 opacity-30" />
              <p className="text-xs">暂无草稿</p>
              <button
                onClick={handleCreateDraft}
                disabled={creating}
                className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600 disabled:opacity-40 transition-colors"
              >
                {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                新建草稿
              </button>
            </div>
          ) : (
            filteredDrafts.map(draft => {
              const isActive = selected?.id === draft.id
              const topicName = flattenTopicsWithDepth(topicList).find(({ plan }) => plan.id === draft.writing_plan_id)?.plan.title
              const type = draftTypeInfo(draft.draft_type)
              return (
                <div
                  key={draft.id}
                  className={cn(
                    'flex border-b border-zinc-100 dark:border-zinc-800',
                    isActive && 'border-l-2 border-l-indigo-400',
                  )}
                >
                  <div className="flex items-start px-2 py-3">
                    <Checkbox
                      checked={selectedDraftIds.has(draft.id)}
                      onCheckedChange={() => toggleDraftSelection(draft.id)}
                      aria-label={`选择${draft.title || '（无标题）'}`}
                      disabled={bulkRunning}
                    />
                  </div>
                  <button
                    onClick={() => handleSelectDraft(draft)}
                    className={cn(
                      'group flex-1 px-2 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900',
                      isActive && 'bg-indigo-50 dark:bg-indigo-950/30',
                    )}
                  >
                    <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      {topicName && (
                        <p className="text-[10px] text-indigo-400 mb-0.5 truncate">
                          {topicName}
                        </p>
                      )}
                      <p className={cn('text-xs font-medium truncate', isActive ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-800 dark:text-zinc-200')}>
                        {draft.title || '（无标题）'}
                      </p>
                      <p className="text-[10px] text-zinc-400 mt-0.5 line-clamp-1 leading-relaxed">
                        {draft.content.replace(/#+\s*/g, '').slice(0, 50) || '空内容'}
                      </p>
                      {/* Platform badges row */}
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', STATUS_STYLES[draft.status])}>
                          {statusLabel(draft.status)}
                        </span>
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', type.badge)}>
                          {type.label}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-[10px] text-zinc-400 flex items-center gap-0.5">
                        <Clock className="w-2.5 h-2.5" />{formatDate(draft.updated_at)}
                      </span>
                      <ChevronRight className={cn('w-3 h-3 text-zinc-300 group-hover:text-zinc-400 transition-colors', isActive && 'text-indigo-400')} />
                    </div>
                    </div>
                  </button>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* ── Right: Editor + Chat ──────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex overflow-hidden bg-white dark:bg-zinc-950">
          {/* Editor column */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">

            {/* Toolbar */}
            <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
              <select
                value={editStatus}
                onChange={e => { setEditStatus(e.target.value); setDirty(true) }}
                className={cn('text-xs px-2 py-1 rounded-full font-medium border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-400', STATUS_STYLES[editStatus])}
              >
                {DRAFT_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>

              <select
                value={editWritingPlanId ?? ''}
                onChange={e => { setEditWritingPlanId(e.target.value ? Number(e.target.value) : null); setDirty(true) }}
                className="text-xs px-2 py-1 rounded-full border border-zinc-200 dark:border-zinc-700 bg-transparent cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-400 text-zinc-600 dark:text-zinc-400 max-w-[160px] truncate"
                title="关联写作模板"
              >
                <option value="">无写作模板</option>
                {flattenTopicsWithDepth(topicList).map(({ plan, label }) => (
                  <option key={plan.id} value={plan.id}>{label}</option>
                ))}
              </select>

              <span className="text-[11px] text-zinc-400">
                v{selected.version} · 更新于 {formatDate(selected.updated_at)} · {wordCount} 字
              </span>

              <div className="ml-auto flex items-center gap-2">
                {dirty && <span className="text-[11px] text-amber-500">有未保存修改</span>}
                <Button
                  variant="outline" size="sm"
                  onClick={() => { setAssetsTab('sources'); setAssetsOpen(true) }}
                  className="gap-1.5"
                  title="灵感来源 · 链接和备注"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  灵感
                  {editSources.length > 0 && (
                    <span className="text-[10px] bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 px-1.5 py-0.5 rounded-full font-medium leading-none">
                      {editSources.length}
                    </span>
                  )}
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={() => { setAssetsTab('images'); setAssetsOpen(true) }}
                  className="gap-1.5"
                  title="图片素材 · 封面在这里管理"
                >
                  <Images className="w-3.5 h-3.5" />
                  素材
                  {images.length > 0 && (
                    <span className="text-[10px] bg-violet-100 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400 px-1.5 py-0.5 rounded-full font-medium leading-none">
                      {images.length}
                    </span>
                  )}
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={() => { window.location.href = '/jobs' }}
                  className="gap-1.5"
                  title="查看 scout→editor→writer→illustrator 每棒的任务详情"
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  工作流
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={() => setPublishOpen(true)}
                  className="gap-1.5"
                  title="发布到公众号 / 复制 X 长文"
                >
                  <Send className="w-3.5 h-3.5" />
                  发布
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={() => setChatOpen(v => !v)}
                  className={cn('gap-1.5', chatOpen && 'bg-violet-50 border-violet-300 text-violet-600 dark:bg-violet-950/30 dark:border-violet-700 dark:text-violet-400')}
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  AI 写作
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="gap-1.5 text-red-500 hover:text-red-600 hover:border-red-300 dark:hover:border-red-700"
                >
                  {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  删除
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving || !dirty} className="gap-1.5">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  保存
                </Button>
              </div>
            </div>

            {/* Title */}
            <div className="px-6 pt-4 pb-2 flex-shrink-0 border-b border-zinc-100 dark:border-zinc-800">
              <input
                value={editTitle}
                onChange={e => { setEditTitle(e.target.value); setDirty(true) }}
                placeholder="标题…"
                className="w-full text-xl font-bold text-zinc-900 dark:text-zinc-100 bg-transparent border-0 outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-700"
              />
            </div>


            {/* Content editor */}
            <div className="flex-1 overflow-hidden">
              <MarkdownEditor
                ref={editorRef}
                value={editContent}
                onChange={v => { setEditContent(v); setDirty(true) }}
              />
            </div>
          </div>

          {/* ── Chat panel ──────────────────────────────────── */}
          {chatOpen && (
            <div className="w-80 flex-shrink-0 border-l border-zinc-200 dark:border-zinc-800 flex flex-col bg-white dark:bg-zinc-950">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <MessageSquare className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
                  <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">AI 写作助手</span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', draftTypeInfo(selected.draft_type).badge)}>
                    {draftTypeInfo(selected.draft_type).label}
                  </span>
                </div>
                <button onClick={handleNewChatSession} className="text-[10px] text-zinc-400 hover:text-violet-500 dark:hover:text-violet-400 flex-shrink-0 transition-colors">
                  新对话
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
                {chatHistory.length === 0 && (
                  <div className="text-center text-zinc-400 text-xs py-6 space-y-2">
                    <MessageSquare className="w-7 h-7 mx-auto opacity-30" />
                    <p>可以说：</p>
                    <div className="space-y-1">
                      {['帮我润色开头', '把语气改得更有力', '压缩到 500 字', '帮我补充一个结尾'].map(s => (
                        <button key={s} onClick={() => setChatInput(s)} className="block w-full text-left px-2 py-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors">{s}</button>
                      ))}
                    </div>
                  </div>
                )}
                {chatHistory.map((m, i) => (
                  <div key={i} className={cn('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
                    <div className={cn('max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap',
                      m.role === 'user' ? 'bg-violet-500 text-white rounded-br-sm' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded-bl-sm')}>
                      {m.content}
                    </div>
                    {m.role === 'assistant' && (
                      <button
                        onClick={() => { setEditContent(m.content); setDirty(true); toast.success('已应用到草稿，记得保存') }}
                        className="mt-1 text-[10px] text-zinc-400 hover:text-violet-500 dark:hover:text-violet-400 transition-colors px-1"
                      >
                        用作草稿
                      </button>
                    )}
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="bg-zinc-100 dark:bg-zinc-800 rounded-xl rounded-bl-sm px-3 py-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                    </div>
                  </div>
                )}
                {pendingContent && (
                  <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-2.5 space-y-2">
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">AI 已生成修改版本</p>
                    <Button size="sm" className="w-full gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-7"
                      onClick={() => { setEditContent(pendingContent); setDirty(true); setPendingContent(null); toast.success('已应用修改，记得保存') }}>
                      <CheckCheck className="w-3.5 h-3.5" />应用到草稿
                    </Button>
                    <button onClick={() => setPendingContent(null)} className="text-[10px] text-zinc-400 hover:text-zinc-600 w-full text-center">忽略</button>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="flex-shrink-0 border-t border-zinc-100 dark:border-zinc-800 p-3">
                <div className="flex gap-2">
                  <textarea
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend() } }}
                    placeholder="输入修改需求… (Enter 发送)"
                    rows={2}
                    className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-violet-400 resize-none text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400"
                  />
                  <button onClick={handleChatSend} disabled={!chatInput.trim() || chatLoading}
                    className="self-end p-2 rounded-lg bg-violet-500 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors">
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-[10px] text-zinc-400 mt-1.5">Shift+Enter 换行</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <BookMarked className="w-12 h-12 opacity-20" />
          <p className="text-sm">选择一篇草稿开始编辑</p>
          <p className="text-xs text-zinc-300">从写作模板参考创作后会自动进入草稿箱</p>
        </div>
      )}

      {/* ── Confirm Dialog ──────────────────────────────────── */}
      <Dialog open={confirmDialog.open} onOpenChange={open => { if (!open) closeConfirm() }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{confirmDialog.title}</DialogTitle>
            <DialogDescription>{confirmDialog.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={closeConfirm}>取消</Button>
            <Button
              variant={confirmDialog.danger ? 'destructive' : 'default'}
              onClick={() => { confirmDialog.onConfirm(); closeConfirm() }}
            >
              {confirmDialog.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {bulkMode ? (
        <BulkImageActionDialog
          open
          mode={bulkMode}
          selectedCount={selectedDraftIds.size}
          running={bulkRunning}
          progress={bulkProgress}
          failures={bulkFailures}
          onClose={() => {
            if (!bulkRunning) setBulkMode(null)
          }}
          onSubmit={options => { void handleBulkImageSubmit(options) }}
        />
      ) : null}

      {selected && (
        <>
          {assetsOpen && (
            <DraftAssetsDialog
              open
              onClose={() => setAssetsOpen(false)}
              initialTab={assetsTab}
              draftId={selected.id}
              sources={editSources}
              onSourcesChange={next => { setEditSources(next); setDirty(true) }}
              images={images}
              imagesLoading={imagesLoading}
              uploading={uploadingImage}
              onUpload={handleImageUpload}
              onDelete={handleImageDelete}
              onInsert={handleInsertImage}
              onRefreshImages={() => {
                getDraftImages(selected.id).then(setImages).catch(() => {})
              }}
            />
          )}
          <PublishDialog
            open={publishOpen}
            onClose={() => setPublishOpen(false)}
            draftId={selected.id}
            title={editTitle}
            content={editContent}
            images={images}
          />
        </>
      )}
    </div>
  )
}
