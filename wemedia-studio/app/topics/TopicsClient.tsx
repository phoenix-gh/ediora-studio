'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  FolderOpen, Folder, Plus, Trash2, Pencil, Check, X,
  Link2, ExternalLink, RefreshCw, ChevronRight, ChevronDown,
  BookMarked, Loader2, Tag, FileText, PenLine,
} from 'lucide-react'
import { marked } from 'marked'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ContentTopic, TopicSource, PLATFORMS,
  getTopics, createTopic, updateTopic, deleteTopic,
  addSource, deleteSource,
} from '@/lib/api/content-topics'
import { createDraft, DRAFT_TYPES } from '@/lib/api/drafts'

marked.setOptions({ breaks: true, gfm: true })

const PRIORITY_LABELS: Record<number, { label: string; cls: string }> = {
  1: { label: 'P1', cls: 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400' },
  2: { label: 'P2', cls: 'bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400' },
  3: { label: 'P3', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
  4: { label: 'P4', cls: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500' },
  5: { label: 'P5', cls: 'bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600' },
}

function platformLabel(p: string) {
  return PLATFORMS.find(x => x.value === p)?.label ?? p
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 3600) return `${Math.floor(diff / 60) || 1} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// ── Tree node ─────────────────────────────────────────────────────────────────

interface TreeNodeProps {
  topic: ContentTopic
  depth: number
  selected: ContentTopic | null
  onSelect: (t: ContentTopic) => void
  onAddChild: (parentId: number) => void
}

function TreeNode({ topic, depth, selected, onSelect, onAddChild }: TreeNodeProps) {
  const [open, setOpen] = useState(true)
  const hasChildren = topic.children.length > 0
  const isSelected = selected?.id === topic.id
  const p = PRIORITY_LABELS[topic.priority] ?? PRIORITY_LABELS[3]

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer group transition-colors text-sm',
          isSelected
            ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300'
            : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900'
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(topic)}
      >
        <button
          onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
          className="w-4 h-4 flex-shrink-0 flex items-center justify-center text-zinc-400"
        >
          {hasChildren
            ? open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
            : <span className="w-3" />}
        </button>

        {hasChildren && open
          ? <FolderOpen className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" />
          : <Folder className="w-3.5 h-3.5 flex-shrink-0 text-zinc-400" />}

        <span className="flex-1 truncate text-xs font-medium">{topic.title}</span>

        {/* clue + draft counts */}
        <span className="flex items-center gap-0.5 flex-shrink-0 w-8 justify-end">
          {topic.sources.length > 0 || topic.draft_count > 0 ? (
            <span className="text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
              {topic.sources.length > 0 && topic.draft_count > 0
                ? `${topic.sources.length}/${topic.draft_count}`
                : topic.sources.length || topic.draft_count}
            </span>
          ) : null}
        </span>

        {depth < 2 && (
          <button
            onClick={e => { e.stopPropagation(); onAddChild(topic.id) }}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-400 hover:text-indigo-500 p-0.5 flex-shrink-0"
            title="添加子主题"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && hasChildren && (
        <div>
          {topic.children.map(child => (
            <TreeNode
              key={child.id}
              topic={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
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
        isActive
          ? 'bg-indigo-50/60 dark:bg-indigo-950/20'
          : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
            {platformLabel(source.platform)}
          </span>
          <span className="text-[10px] text-zinc-400">{formatDate(source.created_at)}</span>
          {source.content && (
            <FileText className="w-3 h-3 text-zinc-300 dark:text-zinc-600 ml-auto flex-shrink-0" />
          )}
        </div>
        {source.title && (
          <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{source.title}</p>
        )}
        {source.note && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 italic">{source.note}</p>
        )}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          onClick={e => { e.stopPropagation(); onCreateDraft(source, 'article') }}
          disabled={!!creating}
          className="opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-wait text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-400 p-0.5"
          title="创作文章"
        >
          {creating === 'article'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <PenLine className="w-3.5 h-3.5" />
          }
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 p-0.5"
          title="删除"
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
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
        <FileText className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
        <span className="flex-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300 truncate">
          {source.title || '原文预览'}
        </span>
        {source.url && (
          <a href={source.url} target="_blank" rel="noopener noreferrer"
            className="text-zinc-400 hover:text-indigo-500 flex-shrink-0">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* rendered markdown */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div
          className="prose prose-sm dark:prose-invert max-w-none
            prose-headings:font-semibold prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100
            prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-p:leading-relaxed
            prose-a:text-indigo-500 prose-a:no-underline hover:prose-a:underline
            prose-img:rounded-lg prose-img:max-w-full prose-img:my-3
            prose-code:text-pink-500 prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 prose-code:px-1 prose-code:rounded
            prose-pre:bg-zinc-100 dark:prose-pre:bg-zinc-900 prose-pre:rounded-lg
            prose-blockquote:border-indigo-300 prose-blockquote:text-zinc-500
            prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface AddSourceForm {
  url: string
  title: string
  content: string
  note: string
  platform: string
}

export function TopicsClient({ initialTopics }: { initialTopics: ContentTopic[] }) {
  const router = useRouter()
  const [topics, setTopics] = useState<ContentTopic[]>(initialTopics)
  const [selected, setSelected] = useState<ContentTopic | null>(initialTopics[0] ?? null)
  const [refreshing, setRefreshing] = useState(false)
  const [creatingDraft, setCreatingDraft] = useState<{ id: number; type: string } | null>(null)

  // Edit topic
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPriority, setEditPriority] = useState(3)
  const [savingMeta, setSavingMeta] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  // New topic form
  const [newParentId, setNewParentId] = useState<number | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newPriority, setNewPriority] = useState(3)
  const [creating, setCreating] = useState(false)
  const newTitleRef = useRef<HTMLInputElement>(null)

  // Add source form
  const [showSourceForm, setShowSourceForm] = useState(false)
  const [sourceForm, setSourceForm] = useState<AddSourceForm>({ url: '', title: '', content: '', note: '', platform: 'manual' })
  const [addingSource, setAddingSource] = useState(false)

  // Deleting
  const [deleting, setDeleting] = useState(false)

  // Source preview panel
  const [previewSource, setPreviewSource] = useState<TopicSource | null>(null)

  // Sync selected when topics refresh
  useEffect(() => {
    if (!selected) return
    const findById = (list: ContentTopic[], id: number): ContentTopic | null => {
      for (const t of list) {
        if (t.id === id) return t
        const found = findById(t.children, id)
        if (found) return found
      }
      return null
    }
    const fresh = findById(topics, selected.id)
    if (fresh) setSelected(fresh)
  }, [topics])

  useEffect(() => {
    if (editingTitle) titleRef.current?.focus()
  }, [editingTitle])

  useEffect(() => {
    if (showNewForm) newTitleRef.current?.focus()
  }, [showNewForm])

  function handleSelectTopic(t: ContentTopic) {
    setSelected(t)
    setPreviewSource(null)
  }

  function openEdit() {
    if (!selected) return
    setEditTitle(selected.title)
    setEditDesc(selected.description)
    setEditPriority(selected.priority)
    setEditingTitle(true)
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const fresh = await getTopics()
      setTopics(fresh)
    } catch { toast.error('刷新失败') }
    finally { setRefreshing(false) }
  }

  async function handleSaveMeta() {
    if (!selected) return
    setSavingMeta(true)
    try {
      const updated = await updateTopic(selected.id, {
        title: editTitle.trim() || selected.title,
        description: editDesc,
        priority: editPriority,
      })
      replaceInTree(updated)
      setEditingTitle(false)
      toast.success('已保存')
    } catch { toast.error('保存失败') }
    finally { setSavingMeta(false) }
  }

  async function handleArchive() {
    if (!selected) return
    if (!confirm(`将「${selected.title}」归档？`)) return
    try {
      const updated = await updateTopic(selected.id, { status: selected.status === 'archived' ? 'active' : 'archived' })
      replaceInTree(updated)
    } catch { toast.error('操作失败') }
  }

  async function handleDelete() {
    if (!selected) return
    if (!confirm(`确定删除「${selected.title}」及其所有子主题和线索？`)) return
    setDeleting(true)
    try {
      await deleteTopic(selected.id)
      const fresh = await getTopics()
      setTopics(fresh)
      setSelected(fresh[0] ?? null)
      toast.success('已删除')
    } catch { toast.error('删除失败') }
    finally { setDeleting(false) }
  }

  function openNewForm(parentId: number | null) {
    setNewParentId(parentId)
    setNewTitle('')
    setNewPriority(3)
    setShowNewForm(true)
  }

  async function handleCreate() {
    const title = newTitle.trim()
    if (!title) return
    setCreating(true)
    try {
      await createTopic({ title, priority: newPriority, parent_id: newParentId })
      const fresh = await getTopics()
      setTopics(fresh)
      setShowNewForm(false)
      setNewTitle('')
      toast.success('主题已创建')
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
      setSelected(prev => prev ? { ...prev, sources: [src, ...prev.sources] } : prev)
      setSourceForm({ url: '', title: '', content: '', note: '', platform: 'manual' })
      setShowSourceForm(false)
      toast.success('线索已添加')
    } catch { toast.error('添加失败') }
    finally { setAddingSource(false) }
  }

  async function handleCreateDraft(source: TopicSource, draftType: string = 'article') {
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
    } catch {
      toast.error('创建草稿失败')
    } finally {
      setCreatingDraft(null)
    }
  }

  async function handleDeleteSource(source: TopicSource) {
    if (!selected) return
    try {
      await deleteSource(selected.id, source.id)
      setSelected(prev => prev ? { ...prev, sources: prev.sources.filter(s => s.id !== source.id) } : prev)
      if (previewSource?.id === source.id) setPreviewSource(null)
    } catch { toast.error('删除失败') }
  }

  function replaceInTree(updated: ContentTopic) {
    const replace = (list: ContentTopic[]): ContentTopic[] =>
      list.map(t => t.id === updated.id
        ? { ...updated, children: t.children, sources: t.sources }
        : { ...t, children: replace(t.children) })
    setTopics(replace)
    if (selected?.id === updated.id) setSelected(prev => prev ? { ...prev, ...updated } : prev)
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: topic tree ───────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <Tag className="w-4 h-4 text-indigo-500" />
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">选题库</span>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={handleRefresh} disabled={refreshing} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40">
              <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            </button>
            <button onClick={() => openNewForm(null)} className="text-zinc-400 hover:text-indigo-500 transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-1">
          {topics.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
              <Folder className="w-8 h-8 opacity-30" />
              <p className="text-xs">暂无主题</p>
              <button onClick={() => openNewForm(null)} className="text-xs text-indigo-500 hover:underline">新建主题</button>
            </div>
          ) : (
            topics.map(t => (
              <TreeNode
                key={t.id}
                topic={t}
                depth={0}
                selected={selected}
                onSelect={handleSelectTopic}
                onAddChild={id => openNewForm(id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* ── Right: detail ──────────────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950">
          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
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
                  <textarea
                    value={editDesc}
                    onChange={e => setEditDesc(e.target.value)}
                    placeholder="主题描述（可选）…"
                    rows={2}
                    className="w-full text-sm bg-transparent border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 outline-none focus:border-indigo-400 resize-none text-zinc-600 dark:text-zinc-400 placeholder:text-zinc-300"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">优先级</span>
                    {[1,2,3,4,5].map(p => {
                      const { label, cls } = PRIORITY_LABELS[p]
                      return (
                        <button
                          key={p}
                          onClick={() => setEditPriority(p)}
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
                  <button onClick={() => setEditingTitle(false)} className="text-zinc-400 hover:text-zinc-600 p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 truncate">{selected.title}</h1>
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0', PRIORITY_LABELS[selected.priority]?.cls)}>
                      {PRIORITY_LABELS[selected.priority]?.label}
                    </span>
                    {selected.status === 'archived' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-400 dark:bg-zinc-800">已归档</span>
                    )}
                  </div>
                  {selected.description && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{selected.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button onClick={openEdit} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1.5 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <Button variant="outline" size="sm" onClick={handleArchive} className="text-xs h-7">
                    {selected.status === 'archived' ? '恢复' : '归档'}
                  </Button>
                  <Button
                    variant="outline" size="sm"
                    onClick={handleDelete} disabled={deleting}
                    className="text-xs h-7 text-red-500 hover:text-red-600 hover:border-red-300"
                  >
                    {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </Button>
                  <Button size="sm" onClick={() => openNewForm(selected.id)} className="text-xs h-7 gap-1" disabled={selected.parent_id !== null && !!topics.find(t => t.children.some(c => c.id === selected.id && c.parent_id !== null))}>
                    <Plus className="w-3.5 h-3.5" /> 子主题
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* Stats bar */}
          <div className="flex items-center gap-6 px-6 py-2.5 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 flex-shrink-0">
            <span className="text-xs text-zinc-500">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">{selected.sources.length}</span> 条线索
            </span>
            <span className="text-xs text-zinc-500">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">{selected.draft_count}</span> 篇草稿
            </span>
            <span className="text-xs text-zinc-500">
              {selected.children.length > 0 && <><span className="font-semibold text-zinc-800 dark:text-zinc-200">{selected.children.length}</span> 个子主题</>}
            </span>
            <span className="ml-auto text-[11px] text-zinc-400">创建于 {formatDate(selected.created_at)}</span>
          </div>

          {/* Sources */}
          <div className="flex-1 overflow-y-auto">
            {/* Add source toolbar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">参考线索</span>
              <button
                onClick={() => setShowSourceForm(v => !v)}
                className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600"
              >
                <Plus className="w-3.5 h-3.5" /> 添加线索
              </button>
            </div>

            {showSourceForm && (
              <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-indigo-50/40 dark:bg-indigo-950/10 space-y-2">
                <div className="flex gap-2">
                  <input
                    value={sourceForm.url}
                    onChange={e => setSourceForm(f => ({ ...f, url: e.target.value }))}
                    placeholder="链接 URL（可选）"
                    className="flex-1 text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400"
                  />
                  <select
                    value={sourceForm.platform}
                    onChange={e => setSourceForm(f => ({ ...f, platform: e.target.value }))}
                    className="text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400"
                  >
                    {PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <input
                  value={sourceForm.title}
                  onChange={e => setSourceForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="标题（可选）"
                  className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400"
                />
                <textarea
                  value={sourceForm.content}
                  onChange={e => setSourceForm(f => ({ ...f, content: e.target.value }))}
                  placeholder="线索正文内容（粘贴原文、推文、要点等…）"
                  rows={4}
                  className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-y"
                />
                <textarea
                  value={sourceForm.note}
                  onChange={e => setSourceForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="备注：方法是否有效、来源可信度等…"
                  rows={2}
                  className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-900 outline-none focus:border-indigo-400 resize-none"
                />
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
                <p className="text-[11px] text-zinc-300">通过 Chrome 插件一键存入，或点击上方手动添加</p>
              </div>
            ) : (
              selected.sources.map(s => (
                <SourceRow
                  key={s.id}
                  source={s}
                  onDelete={() => handleDeleteSource(s)}
                  onPreview={src => setPreviewSource(prev => prev?.id === src.id ? null : src)}
                  onCreateDraft={handleCreateDraft}
                  isActive={previewSource?.id === s.id}
                  creating={creatingDraft?.id === s.id ? creatingDraft.type : false}
                />
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <BookMarked className="w-12 h-12 opacity-20" />
          <p className="text-sm">选择一个主题查看详情</p>
          <button onClick={() => openNewForm(null)} className="text-xs text-indigo-500 hover:underline flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> 新建第一个主题
          </button>
        </div>
      )}

      {/* ── Right: source preview panel ───────────────────────── */}
      {previewSource && (
        <SourcePreview source={previewSource} onClose={() => setPreviewSource(null)} />
      )}

      {/* ── New topic modal ────────────────────────────────── */}
      {showNewForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowNewForm(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 w-96 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
              {newParentId ? '新建子主题' : '新建主题'}
            </h3>
            <input
              ref={newTitleRef}
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false) }}
              placeholder="主题名称…"
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-sm"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">优先级</span>
              {[1,2,3,4,5].map(p => {
                const { label, cls } = PRIORITY_LABELS[p]
                return (
                  <button
                    key={p}
                    onClick={() => setNewPriority(p)}
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
