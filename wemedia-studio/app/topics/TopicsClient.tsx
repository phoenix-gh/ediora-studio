'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, Trash2, Pencil, Check, X, RefreshCw,
  BookMarked, Loader2, Tag, FileText, PenLine,
  Link2, ExternalLink, SendHorizonal, Rocket,
} from 'lucide-react'
import { marked } from 'marked'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContentTopic, TopicTag, TopicSource, DraftSummary,
  getTopics, getTags, createTopic, updateTopic, deleteTopic,
  addSource, deleteSource, getTopicDrafts, dispatchTopic,
  PLATFORMS,
} from '@/lib/api/content-topics'
import { createDraft } from '@/lib/api/drafts'
import { PushToStudioPopover } from '@/components/features/PushToStudioPopover'

marked.setOptions({ breaks: true, gfm: true })

const PRIORITY_LABELS: Record<number, { label: string; cls: string }> = {
  1: { label: 'P1', cls: 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
  2: { label: 'P2', cls: 'bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400' },
  3: { label: 'P3', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
  4: { label: 'P4', cls: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500' },
  5: { label: 'P5', cls: 'bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600' },
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 3600) return `${Math.floor(diff / 60) || 1} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function platformLabel(p: string) {
  return PLATFORMS.find(x => x.value === p)?.label ?? p
}

// ── Tag chip ──────────────────────────────────────────────────────────────────

function TagChip({ tag, onRemove }: { tag: TopicTag; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
      style={{ backgroundColor: tag.color + '22', color: tag.color }}
    >
      {tag.name}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-70 leading-none">×</button>
      )}
    </span>
  )
}

// ── Source row ────────────────────────────────────────────────────────────────

function SourceRow({ source, onDelete, onPreview, onCreateDraft, isActive, creating }: {
  source: TopicSource
  onDelete: () => void
  onPreview: (s: TopicSource) => void
  onCreateDraft: (s: TopicSource, type: string) => void
  isActive: boolean
  creating: string | false
}) {
  return (
    <div
      onClick={() => onPreview(source)}
      className={cn(
        'flex items-start gap-3 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 group transition-colors cursor-pointer',
        isActive ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
            {platformLabel(source.platform)}
          </span>
          <span className="text-[10px] text-zinc-400">{formatDate(source.created_at)}</span>
          {source.content && <FileText className="w-3 h-3 text-zinc-300 dark:text-zinc-600 ml-auto flex-shrink-0" />}
        </div>
        {source.title && <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{source.title}</p>}
        {source.note && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 italic">{source.note}</p>}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {source.url && source.title && (
          <div onClick={e => e.stopPropagation()} className="opacity-0 group-hover:opacity-100 transition-opacity">
            <PushToStudioPopover url={source.url} title={source.title} content={source.content || ''} platform={source.platform} summary={source.note || ''} className="w-6 h-6" />
          </div>
        )}
        <button
          onClick={e => { e.stopPropagation(); onCreateDraft(source, 'article') }}
          disabled={!!creating}
          className="opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-wait text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-400 p-0.5"
          title="创作文章"
        >
          {creating === 'article' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PenLine className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 p-0.5"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}

// ── Source preview panel ──────────────────────────────────────────────────────

function SourcePreview({ source, onClose }: { source: TopicSource; onClose: () => void }) {
  const html = useMemo(() => marked(source.content || '') as string, [source.content])
  return (
    <div className="w-96 flex-shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
        <FileText className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
        <span className="flex-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300 truncate">{source.title || '原文预览'}</span>
        {source.url && (
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-indigo-500 flex-shrink-0">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div
          className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-p:leading-relaxed prose-a:text-indigo-500 prose-a:no-underline hover:prose-a:underline prose-code:text-pink-500 prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 prose-code:px-1 prose-code:rounded prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-900 prose-pre:rounded-lg prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface AddSourceForm {
  url: string; title: string; content: string; note: string; platform: string
}

type ActiveTab = 'brief' | 'sources' | 'drafts'

export function TopicsClient({ initialTopics, initialTags }: {
  initialTopics: ContentTopic[]
  initialTags: TopicTag[]
}) {
  const router = useRouter()
  const [topics, setTopics] = useState<ContentTopic[]>(initialTopics)
  const [allTags, setAllTags] = useState<TopicTag[]>(initialTags)
  const [selected, setSelected] = useState<ContentTopic | null>(initialTopics[0] ?? null)
  const [filterTagNames, setFilterTagNames] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('brief')
  const [refreshing, setRefreshing] = useState(false)

  // Brief editing
  const [briefDraft, setBriefDraft] = useState('')
  const [savingBrief, setSavingBrief] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false)
  const [dispatchBrief, setDispatchBrief] = useState('')

  // Title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editPriority, setEditPriority] = useState(3)
  const [savingMeta, setSavingMeta] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  // New topic
  const [showNewForm, setShowNewForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPriority, setNewPriority] = useState(3)
  const [creating, setCreating] = useState(false)
  const newTitleRef = useRef<HTMLInputElement>(null)

  // Tag editing
  const [tagInput, setTagInput] = useState('')

  // Source form
  const [showSourceForm, setShowSourceForm] = useState(false)
  const [sourceForm, setSourceForm] = useState<AddSourceForm>({ url: '', title: '', content: '', note: '', platform: 'manual' })
  const [addingSource, setAddingSource] = useState(false)
  const [previewSource, setPreviewSource] = useState<TopicSource | null>(null)
  const [creatingDraft, setCreatingDraft] = useState<{ id: number; type: string } | null>(null)

  // Drafts tab
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [loadingDrafts, setLoadingDrafts] = useState(false)

  // Deleting
  const [deleting, setDeleting] = useState(false)

  // Sync selected topic when topics list refreshes
  useEffect(() => {
    if (!selected) return
    const fresh = topics.find(t => t.id === selected.id)
    if (fresh) setSelected(fresh)
  }, [topics])

  // Sync brief draft when topic changes
  useEffect(() => {
    setBriefDraft(selected?.brief ?? '')
  }, [selected?.id])

  useEffect(() => {
    if (editingTitle) titleRef.current?.focus()
  }, [editingTitle])

  useEffect(() => {
    if (showNewForm) newTitleRef.current?.focus()
  }, [showNewForm])

  // Load drafts when tab switches
  useEffect(() => {
    if (activeTab !== 'drafts' || !selected) return
    setLoadingDrafts(true)
    getTopicDrafts(selected.id)
      .then(setDrafts)
      .catch(() => toast.error('加载产出失败'))
      .finally(() => setLoadingDrafts(false))
  }, [activeTab, selected?.id])

  // Derived: visible topics
  const visibleTopics = useMemo(() => {
    let list = topics
    if (filterTagNames.length > 0) {
      list = list.filter(t =>
        filterTagNames.some(name => t.tags.some(tag => tag.name === name))
      )
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) || t.brief.toLowerCase().includes(q)
      )
    }
    return list
  }, [topics, filterTagNames, searchQuery])

  // Derived: unique tags
  const availableTags = useMemo(() => {
    const byName = new Map<string, TopicTag>()
    allTags.forEach(t => byName.set(t.name, t))
    topics.forEach(topic => topic.tags.forEach(tag => byName.set(tag.name, tag)))
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [topics, allTags])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const [freshTopics, freshTags] = await Promise.all([getTopics(), getTags()])
      setTopics(freshTopics)
      setAllTags(freshTags)
    } catch { toast.error('刷新失败') }
    finally { setRefreshing(false) }
  }

  function toggleFilterTag(name: string) {
    setFilterTagNames(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    )
  }

  function handleSelectTopic(t: ContentTopic) {
    setSelected(t)
    setPreviewSource(null)
    setActiveTab('brief')
  }

  function openEdit() {
    if (!selected) return
    setEditTitle(selected.title)
    setEditPriority(selected.priority)
    setEditingTitle(true)
  }

  async function handleSaveMeta() {
    if (!selected) return
    setSavingMeta(true)
    try {
      const updated = await updateTopic(selected.id, {
        title: editTitle.trim() || selected.title,
        priority: editPriority,
      })
      replaceInList(updated)
      setEditingTitle(false)
    } catch { toast.error('保存失败') }
    finally { setSavingMeta(false) }
  }

  async function handleAddTagToTopic(name: string) {
    if (!selected || !name.trim()) return
    const newNames = [...selected.tags.map(t => t.name), name.trim()]
    try {
      const updated = await updateTopic(selected.id, { tags: newNames })
      replaceInList(updated)
      getTags().then(setAllTags).catch(() => {})
    } catch { toast.error('添加标签失败') }
    setTagInput('')
  }

  async function handleRemoveTagFromTopic(tagName: string) {
    if (!selected) return
    const newNames = selected.tags.filter(t => t.name !== tagName).map(t => t.name)
    try {
      const updated = await updateTopic(selected.id, { tags: newNames })
      replaceInList(updated)
    } catch { toast.error('移除标签失败') }
  }

  async function handleSaveBrief() {
    if (!selected) return
    setSavingBrief(true)
    try {
      const updated = await updateTopic(selected.id, { brief: briefDraft })
      replaceInList(updated)
      toast.success('已保存')
    } catch { toast.error('保存失败') }
    finally { setSavingBrief(false) }
  }

  function openDispatchConfirm() {
    setDispatchBrief(briefDraft)
    setShowDispatchConfirm(true)
  }

  async function handleDispatch() {
    if (!selected) return
    // Save dispatchBrief (modal may differ from briefDraft if user edited it in the modal)
    if (dispatchBrief !== selected.brief) {
      try {
        const updated = await updateTopic(selected.id, { brief: dispatchBrief })
        replaceInList(updated)
        setBriefDraft(dispatchBrief)
      } catch { toast.error('保存 brief 失败'); return }
    }
    setDispatching(true)
    try {
      const result = await dispatchTopic(selected.id)
      setShowDispatchConfirm(false)
      toast.success('已派发给 Agent', {
        action: { label: '查看看板', onClick: () => router.push(result.kanban_url) },
      })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '派发失败')
    } finally { setDispatching(false) }
  }

  async function handleArchive() {
    if (!selected) return
    try {
      const updated = await updateTopic(selected.id, {
        status: selected.status === 'archived' ? 'active' : 'archived',
      })
      replaceInList(updated)
    } catch { toast.error('操作失败') }
  }

  async function handleDelete() {
    if (!selected) return
    if (!confirm(`确定删除「${selected.title}」及其所有线索？`)) return
    setDeleting(true)
    try {
      await deleteTopic(selected.id)
      const fresh = await getTopics()
      setTopics(fresh)
      setSelected(fresh[0] ?? null)
    } catch { toast.error('删除失败') }
    finally { setDeleting(false) }
  }

  async function handleCreate() {
    const title = newTitle.trim()
    if (!title) return
    setCreating(true)
    try {
      await createTopic({ title, priority: newPriority, tags: [] })
      const fresh = await getTopics()
      setTopics(fresh)
      setSelected(fresh.find(t => t.title === title) ?? fresh[0])
      setShowNewForm(false)
      setNewTitle('')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally { setCreating(false) }
  }

  async function handleAddSource() {
    if (!selected) return
    setAddingSource(true)
    try {
      const src = await addSource(selected.id, {
        url: sourceForm.url.trim(),
        title: sourceForm.title.trim(),
        content: sourceForm.content.trim(),
        note: sourceForm.note.trim(),
        platform: sourceForm.platform,
      })
      setSelected(prev => prev ? { ...prev, sources: [src, ...prev.sources], source_count: prev.source_count + 1 } : prev)
      setSourceForm({ url: '', title: '', content: '', note: '', platform: 'manual' })
      setShowSourceForm(false)
      toast.success('线索已添加')
    } catch { toast.error('添加失败') }
    finally { setAddingSource(false) }
  }

  async function handleDeleteSource(source: TopicSource) {
    if (!selected) return
    try {
      await deleteSource(selected.id, source.id)
      setSelected(prev => prev ? {
        ...prev,
        sources: prev.sources.filter(s => s.id !== source.id),
        source_count: prev.source_count - 1,
      } : prev)
      if (previewSource?.id === source.id) setPreviewSource(null)
    } catch { toast.error('删除失败') }
  }

  async function handleCreateDraft(source: TopicSource, draftType = 'article') {
    setCreatingDraft({ id: source.id, type: draftType })
    try {
      const draft = await createDraft({
        topic_id: 'manual',
        title: source.title || '',
        content: source.content || '',
        draft_type: draftType,
        content_topic_id: selected?.id ?? null,
        sources: source.url ? [{ url: source.url, title: source.title, note: source.note }] : [],
      })
      router.push(`/drafts?draft=${draft.id}&chat=1`)
    } catch { toast.error('创建草稿失败') }
    finally { setCreatingDraft(null) }
  }

  function replaceInList(updated: ContentTopic) {
    setTopics(prev => prev.map(t => t.id === updated.id ? updated : t))
    if (selected?.id === updated.id) setSelected(updated)
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: tag filter + card list ─────────────────────── */}
      <aside className="w-72 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 space-y-3">
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-indigo-500" />
            <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">选题库</span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={handleRefresh} disabled={refreshing} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40">
                <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              </button>
              <button onClick={() => setShowNewForm(true)} className="text-zinc-400 hover:text-indigo-500 transition-colors">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索选题…"
            className="w-full text-xs px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400"
          />
          {availableTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {availableTags.map(tag => (
                <button
                  key={tag.id}
                  onClick={() => toggleFilterTag(tag.name)}
                  className={cn(
                    'text-[10px] px-2 py-0.5 rounded-full font-medium transition-all border',
                    filterTagNames.includes(tag.name)
                      ? 'border-transparent'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300'
                  )}
                  style={filterTagNames.includes(tag.name) ? {
                    backgroundColor: tag.color + '33',
                    color: tag.color,
                    borderColor: tag.color + '66',
                  } : {}}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {visibleTopics.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
              <BookMarked className="w-8 h-8 opacity-20" />
              <p className="text-xs">暂无选题</p>
              <button onClick={() => setShowNewForm(true)} className="text-xs text-indigo-500 hover:underline">新建选题</button>
            </div>
          ) : (
            visibleTopics.map(t => {
              const p = PRIORITY_LABELS[t.priority] ?? PRIORITY_LABELS[3]
              const isSelected = selected?.id === t.id
              return (
                <div
                  key={t.id}
                  onClick={() => handleSelectTopic(t)}
                  className={cn(
                    'px-3 py-2.5 rounded-lg cursor-pointer transition-colors border',
                    isSelected
                      ? 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800'
                      : 'bg-white dark:bg-zinc-950 border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-bold flex-shrink-0', p.cls)}>{p.label}</span>
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate flex-1">{t.title}</span>
                    {t.status === 'archived' && <span className="text-[9px] text-zinc-400 flex-shrink-0">归档</span>}
                  </div>
                  {t.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {t.tags.slice(0, 3).map(tag => <TagChip key={tag.id} tag={tag} />)}
                      {t.tags.length > 3 && <span className="text-[10px] text-zinc-400">+{t.tags.length - 3}</span>}
                    </div>
                  )}
                  {t.brief && (
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500 line-clamp-2 leading-relaxed">{t.brief.slice(0, 100)}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1.5">
                    {t.source_count > 0 && (
                      <span className="text-[10px] text-zinc-400"><span className="font-medium text-zinc-600 dark:text-zinc-400">{t.source_count}</span> 条线索</span>
                    )}
                    {t.draft_count > 0 && (
                      <span className="text-[10px] text-zinc-400"><span className="font-medium text-zinc-600 dark:text-zinc-400">{t.draft_count}</span> 篇产出</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* ── Right: detail ────────────────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950">
          {/* Header */}
          <div className="flex items-start gap-3 px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
            {editingTitle ? (
              <div className="flex-1 flex items-start gap-2">
                <div className="flex-1 space-y-2">
                  <input
                    ref={titleRef}
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveMeta(); if (e.key === 'Escape') setEditingTitle(false) }}
                    className="w-full text-lg font-bold bg-transparent border-b border-indigo-400 outline-none text-zinc-900 dark:text-zinc-100"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">优先级</span>
                    {[1,2,3,4,5].map(p => {
                      const { label, cls } = PRIORITY_LABELS[p]
                      return (
                        <button key={p} onClick={() => setEditPriority(p)}
                          className={cn('text-[11px] px-2 py-0.5 rounded font-semibold transition-all', editPriority === p ? cls : 'bg-zinc-50 text-zinc-400 dark:bg-zinc-900')}
                        >{label}</button>
                      )
                    })}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0 pt-1">
                  <button onClick={handleSaveMeta} disabled={savingMeta} className="text-indigo-500 hover:text-indigo-600 p-1">
                    {savingMeta ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button onClick={() => setEditingTitle(false)} className="text-zinc-400 hover:text-zinc-600 p-1"><X className="w-4 h-4" /></button>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 truncate">{selected.title}</h1>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0', PRIORITY_LABELS[selected.priority]?.cls)}>
                    {PRIORITY_LABELS[selected.priority]?.label}
                  </span>
                  {selected.status === 'archived' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-400 dark:bg-zinc-800">已归档</span>
                  )}
                  <button onClick={openEdit} className="ml-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                    <Button variant="outline" size="sm" onClick={handleArchive} className="text-xs h-7">
                      {selected.status === 'archived' ? '恢复' : '归档'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDelete} disabled={deleting}
                      className="text-xs h-7 text-red-500 hover:text-red-600 hover:border-red-300">
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </div>
                {/* Tags */}
                <div className="flex flex-wrap items-center gap-1">
                  {selected.tags.map(tag => (
                    <TagChip key={tag.id} tag={tag} onRemove={() => handleRemoveTagFromTopic(tag.name)} />
                  ))}
                  <input
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => {
                      if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                        e.preventDefault()
                        handleAddTagToTopic(tagInput.trim())
                      }
                    }}
                    placeholder="添加标签…"
                    className="text-[10px] px-1.5 py-0.5 border border-dashed border-zinc-300 dark:border-zinc-600 rounded-full outline-none focus:border-indigo-400 bg-transparent text-zinc-500 placeholder:text-zinc-400 w-20"
                    list="tag-suggestions"
                  />
                  <datalist id="tag-suggestions">
                    {availableTags.map(t => <option key={t.id} value={t.name} />)}
                  </datalist>
                </div>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-zinc-100 dark:border-zinc-800 px-6 flex-shrink-0">
            {(['brief', 'sources', 'drafts'] as ActiveTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'text-xs py-2.5 px-1 mr-6 font-medium border-b-2 transition-colors',
                  activeTab === tab
                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                )}
              >
                {tab === 'brief' ? 'Brief' : tab === 'sources' ? `线索 (${selected.source_count})` : `产出 (${selected.draft_count})`}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex">
            {activeTab === 'brief' && (
              <div className="flex-1 flex flex-col p-6 overflow-hidden">
                <textarea
                  value={briefDraft}
                  onChange={e => setBriefDraft(e.target.value)}
                  placeholder={`## 调研主题\n\n## 搜索范围\n\n## 提取要求\n\n## 输出格式`}
                  className="flex-1 text-sm font-mono bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-4 py-3 outline-none focus:border-indigo-400 resize-none text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-300 dark:placeholder:text-zinc-600 leading-relaxed"
                />
                <div className="flex items-center gap-2 mt-3 flex-shrink-0">
                  <Button size="sm" onClick={handleSaveBrief} disabled={savingBrief || briefDraft === selected.brief} className="gap-1 text-xs h-8">
                    {savingBrief ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 保存
                  </Button>
                  <Button size="sm" variant="outline" onClick={openDispatchConfirm} disabled={!briefDraft.trim()} className="gap-1 text-xs h-8 text-indigo-600 border-indigo-300 hover:bg-indigo-50">
                    <Rocket className="w-3.5 h-3.5" /> 派发给 Agent
                  </Button>
                  {briefDraft !== selected.brief && (
                    <span className="text-[11px] text-zinc-400 ml-auto">未保存</span>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'sources' && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
                  <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">参考线索</span>
                  <button onClick={() => setShowSourceForm(v => !v)} className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600">
                    <Plus className="w-3.5 h-3.5" /> 添加线索
                  </button>
                </div>
                {showSourceForm && (
                  <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-indigo-50/40 dark:bg-indigo-950/10 space-y-2">
                    <div className="flex gap-2">
                      <input value={sourceForm.url} onChange={e => setSourceForm(f => ({ ...f, url: e.target.value }))} placeholder="链接 URL（可选）"
                        className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400" />
                      <select value={sourceForm.platform} onChange={e => setSourceForm(f => ({ ...f, platform: e.target.value }))}
                        className="text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400">
                        {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </div>
                    <input value={sourceForm.title} onChange={e => setSourceForm(f => ({ ...f, title: e.target.value }))} placeholder="标题（可选）"
                      className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400" />
                    <textarea value={sourceForm.content} onChange={e => setSourceForm(f => ({ ...f, content: e.target.value }))} placeholder="线索正文内容…" rows={4}
                      className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-y" />
                    <textarea value={sourceForm.note} onChange={e => setSourceForm(f => ({ ...f, note: e.target.value }))} placeholder="备注…" rows={2}
                      className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-none" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleAddSource} disabled={addingSource} className="text-xs h-7 gap-1">
                        {addingSource ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} 保存
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setShowSourceForm(false)} className="text-xs h-7">取消</Button>
                    </div>
                  </div>
                )}
                {selected.sources.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
                    <Link2 className="w-8 h-8 opacity-20" />
                    <p className="text-xs">暂无线索</p>
                  </div>
                ) : (
                  selected.sources.map(s => (
                    <SourceRow key={s.id} source={s}
                      onDelete={() => handleDeleteSource(s)}
                      onPreview={src => setPreviewSource(prev => prev?.id === src.id ? null : src)}
                      onCreateDraft={handleCreateDraft}
                      isActive={previewSource?.id === s.id}
                      creating={creatingDraft?.id === s.id ? creatingDraft.type : false}
                    />
                  ))
                )}
              </div>
            )}

            {activeTab === 'drafts' && (
              <div className="flex-1 overflow-y-auto">
                {loadingDrafts ? (
                  <div className="flex items-center justify-center h-40">
                    <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
                  </div>
                ) : drafts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
                    <FileText className="w-8 h-8 opacity-20" />
                    <p className="text-xs">暂无产出</p>
                    <p className="text-[11px] text-zinc-300">从线索创作草稿，或在草稿页关联此选题</p>
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {drafts.map(d => (
                      <div
                        key={d.id}
                        onClick={() => router.push(`/drafts?draft=${d.id}`)}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 cursor-pointer group"
                      >
                        <FileText className="w-4 h-4 text-zinc-300 dark:text-zinc-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                            {d.title || '（无标题）'}
                          </p>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            {d.draft_type === 'article' ? '文章' : '脚本'} · {d.status} · {formatDate(d.created_at)}
                          </p>
                        </div>
                        <ExternalLink className="w-3.5 h-3.5 text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'sources' && previewSource && (
              <SourcePreview source={previewSource} onClose={() => setPreviewSource(null)} />
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <BookMarked className="w-12 h-12 opacity-20" />
          <p className="text-sm">选择一个选题查看详情</p>
          <button onClick={() => setShowNewForm(true)} className="text-xs text-indigo-500 hover:underline flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> 新建第一个选题
          </button>
        </div>
      )}

      {/* ── Dispatch confirm modal ──────────────────────────── */}
      {showDispatchConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowDispatchConfirm(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 w-[560px] space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Rocket className="w-4 h-4 text-indigo-500" />
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">派发给 Scout Agent</h3>
            </div>
            <p className="text-xs text-zinc-500">以下 brief 将作为 Hermes kanban 任务发送给 scout。可在下方编辑后再派发。</p>
            <textarea
              value={dispatchBrief}
              onChange={e => setDispatchBrief(e.target.value)}
              rows={10}
              className="w-full text-xs font-mono px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-zinc-50 dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-none"
            />
            <div className="flex gap-2 justify-end pt-1">
              <Button variant="outline" onClick={() => setShowDispatchConfirm(false)} className="text-xs h-8">取消</Button>
              <Button onClick={handleDispatch} disabled={dispatching || !dispatchBrief.trim()} className="text-xs h-8 gap-1">
                {dispatching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SendHorizonal className="w-3.5 h-3.5" />} 确认派发
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── New topic modal ─────────────────────────────────── */}
      {showNewForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowNewForm(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">新建选题</h3>
            <input
              ref={newTitleRef}
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false) }}
              placeholder="选题名称…"
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-sm"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">优先级</span>
              {[1,2,3,4,5].map(p => {
                const { label, cls } = PRIORITY_LABELS[p]
                return (
                  <button key={p} onClick={() => setNewPriority(p)}
                    className={cn('text-[11px] px-2 py-0.5 rounded font-semibold transition-all', newPriority === p ? cls : 'bg-zinc-50 text-zinc-400 dark:bg-zinc-900')}
                  >{label}</button>
                )
              })}
            </div>
            <div className="flex gap-2 pt-1">
              <Button onClick={handleCreate} disabled={creating || !newTitle.trim()} className="flex-1 gap-1">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} 创建
              </Button>
              <Button variant="outline" onClick={() => setShowNewForm(false)}>取消</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
