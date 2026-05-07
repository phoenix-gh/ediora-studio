'use client'

import { useState, useEffect, useCallback } from 'react'
import { BookMarked, Trash2, Save, RefreshCw, FileText, Clock, ChevronRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Draft, DraftUpdate, DRAFT_STATUSES, getDrafts, updateDraft, deleteDraft } from '@/lib/api/drafts'
import { MarkdownEditor } from './MarkdownEditor'
import '@uiw/react-md-editor/markdown-editor.css'

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

function sourceLabel(topic_id: string) {
  if (topic_id === 'x') return 'X 帖子创作'
  return '选题生成'
}

export function DraftsClient({ initialDrafts }: { initialDrafts: Draft[] }) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts)
  const [selected, setSelected] = useState<Draft | null>(initialDrafts[0] ?? null)
  const [filterStatus, setFilterStatus] = useState<string>('all')

  // Editor state — synced from selected
  const [editTitle, setEditTitle] = useState(selected?.title ?? '')
  const [editContent, setEditContent] = useState(selected?.content ?? '')
  const [editStatus, setEditStatus] = useState(selected?.status ?? 'drafting')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // When selected changes, reset editor
  useEffect(() => {
    if (!selected) return
    setEditTitle(selected.title)
    setEditContent(selected.content)
    setEditStatus(selected.status)
    setDirty(false)
  }, [selected?.id])

  const filtered = drafts.filter(d => filterStatus === 'all' || d.status === filterStatus)

  const handleSelect = useCallback((d: Draft) => {
    if (dirty) {
      if (!confirm('有未保存的修改，确定切换？')) return
    }
    setSelected(d)
  }, [dirty])

  async function handleSave() {
    if (!selected) return
    setSaving(true)
    try {
      const body: DraftUpdate = {}
      if (editTitle !== selected.title) body.title = editTitle
      if (editContent !== selected.content) body.content = editContent
      if (editStatus !== selected.status) body.status = editStatus
      const updated = await updateDraft(selected.id, body)
      setDrafts(ds => ds.map(d => d.id === updated.id ? updated : d))
      setSelected(updated)
      setDirty(false)
      toast.success('已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!selected) return
    if (!confirm(`确定删除「${selected.title}」？此操作不可恢复。`)) return
    setDeleting(true)
    try {
      await deleteDraft(selected.id)
      const next = drafts.filter(d => d.id !== selected.id)
      setDrafts(next)
      setSelected(next[0] ?? null)
      toast.success('已删除')
    } catch {
      toast.error('删除失败')
    } finally {
      setDeleting(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const fresh = await getDrafts()
      setDrafts(fresh)
      if (selected) {
        const refreshed = fresh.find(d => d.id === selected.id)
        if (refreshed) setSelected(refreshed)
      }
    } catch {
      toast.error('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  // Ctrl/Cmd + S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (dirty) handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dirty, editTitle, editContent, editStatus])

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Left: Draft list ──────────────────────────────── */}
      <aside className="w-72 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
        {/* Header */}
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <BookMarked className="w-4 h-4 text-indigo-500" />
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">草稿箱</span>
          <span className="ml-auto text-xs text-zinc-400">{drafts.length} 篇</span>
          <button onClick={handleRefresh} disabled={refreshing} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40">
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>

        {/* Status filter */}
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 flex gap-1 flex-wrap">
          <button
            onClick={() => setFilterStatus('all')}
            className={cn('text-[11px] px-2 py-0.5 rounded-full transition-colors',
              filterStatus === 'all'
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            )}
          >全部</button>
          {DRAFT_STATUSES.map(s => (
            <button
              key={s.value}
              onClick={() => setFilterStatus(s.value)}
              className={cn('text-[11px] px-2 py-0.5 rounded-full transition-colors',
                filterStatus === s.value
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              )}
            >{s.label}</button>
          ))}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-400 gap-2">
              <FileText className="w-8 h-8 opacity-30" />
              <p className="text-xs">暂无草稿</p>
            </div>
          ) : (
            filtered.map(d => (
              <button
                key={d.id}
                onClick={() => handleSelect(d)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors group',
                  selected?.id === d.id && 'bg-indigo-50 dark:bg-indigo-950/30 border-l-2 border-l-indigo-400'
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-xs font-medium truncate',
                      selected?.id === d.id ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-800 dark:text-zinc-200'
                    )}>
                      {d.title || '（无标题）'}
                    </p>
                    <p className="text-[10px] text-zinc-400 mt-0.5 line-clamp-2 leading-relaxed">
                      {d.content.replace(/#+\s*/g, '').slice(0, 60)}…
                    </p>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', STATUS_STYLES[d.status])}>
                        {statusLabel(d.status)}
                      </span>
                      <span className="text-[10px] text-zinc-400">{sourceLabel(d.topic_id)}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-[10px] text-zinc-400 flex items-center gap-0.5">
                      <Clock className="w-2.5 h-2.5" />{formatDate(d.updated_at)}
                    </span>
                    <ChevronRight className={cn('w-3 h-3 text-zinc-300 group-hover:text-zinc-400 transition-colors', selected?.id === d.id && 'text-indigo-400')} />
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* ── Right: Editor ─────────────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950">
          {/* Toolbar */}
          <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
            {/* Status selector */}
            <select
              value={editStatus}
              onChange={e => { setEditStatus(e.target.value); setDirty(true) }}
              className={cn(
                'text-xs px-2 py-1 rounded-full font-medium border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-400',
                STATUS_STYLES[editStatus]
              )}
            >
              {DRAFT_STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>

            <span className="text-[11px] text-zinc-400">
              v{selected.version} · 更新于 {formatDate(selected.updated_at)}
              {selected.topic_id === 'x' && ' · X 帖子创作'}
            </span>

            <div className="ml-auto flex items-center gap-2">
              {dirty && <span className="text-[11px] text-amber-500">有未保存修改</span>}
              <Button
                variant="outline"
                size="sm"
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
              placeholder="文章标题…"
              className="w-full text-xl font-bold text-zinc-900 dark:text-zinc-100 bg-transparent border-0 outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-700"
            />
          </div>

          {/* Content — Markdown editor */}
          <div className="flex-1 overflow-hidden">
            <MarkdownEditor
              value={editContent}
              onChange={v => { setEditContent(v); setDirty(true) }}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <BookMarked className="w-12 h-12 opacity-20" />
          <p className="text-sm">选择一篇草稿开始编辑</p>
          <p className="text-xs text-zinc-300">从 X 帖子创作的文章会自动进入草稿箱</p>
        </div>
      )}
    </div>
  )
}
