'use client'

import { useState } from 'react'
import { Quote as QuoteIcon, Plus, Search, Trash2, Pencil, Check, X, Copy, ExternalLink, RefreshCw, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Quote, QuoteCreate, QuoteUpdate,
  SCENE_TAGS, sceneTagInfo,
  getQuotes, createQuote, updateQuote, deleteQuote,
} from '@/lib/api/quotes'
import { WritingPlan, flattenTopics } from '@/lib/api/writing-plans'

// ── Scene tag badge ───────────────────────────────────────────────────────────

function SceneTag({ value }: { value: string }) {
  const info = sceneTagInfo(value)
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', info.color)}>
      {info.label}
    </span>
  )
}

// ── Quote card ────────────────────────────────────────────────────────────────

interface QuoteCardProps {
  quote: Quote
  planMap: Record<number, string>
  onEdit: (q: Quote) => void
  onDelete: (q: Quote) => void
}

function QuoteCard({ quote, planMap, onEdit, onDelete }: QuoteCardProps) {
  function handleCopy() {
    const text = quote.author ? `"${quote.text}" —— ${quote.author}` : `"${quote.text}"`
    navigator.clipboard.writeText(text)
    toast.success('已复制')
  }

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 group hover:border-indigo-200 dark:hover:border-indigo-800 transition-colors">
      {/* Quote text */}
      <blockquote className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed mb-3 font-medium">
        "{quote.text}"
      </blockquote>

      {/* Meta */}
      {(quote.author || quote.source) && (
        <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 mb-3">
          {quote.author && <span>—— {quote.author}</span>}
          {quote.author && quote.source && <span>·</span>}
          {quote.source && (
            quote.source_url
              ? <a href={quote.source_url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-500 flex items-center gap-0.5">
                  {quote.source} <ExternalLink className="w-2.5 h-2.5" />
                </a>
              : <span>{quote.source}</span>
          )}
        </div>
      )}

      {/* Tags */}
      {quote.scene_tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {quote.scene_tags.map(t => <SceneTag key={t} value={t} />)}
        </div>
      )}

      {/* Plan association */}
      {quote.writing_plan_id && planMap[quote.writing_plan_id] && (
        <p className="text-[10px] text-zinc-400 mb-2">
          # {planMap[quote.writing_plan_id]}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={handleCopy} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1 rounded" title="复制">
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => onEdit(quote)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-1 rounded" title="编辑">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => onDelete(quote)} className="text-zinc-400 hover:text-red-500 p-1 rounded" title="删除">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

// ── Quote form ────────────────────────────────────────────────────────────────

interface QuoteFormProps {
  initial?: Quote
  plans: WritingPlan[]
  onSave: (data: QuoteCreate | QuoteUpdate) => Promise<void>
  onCancel: () => void
  saving: boolean
}

function QuoteForm({ initial, plans, onSave, onCancel, saving }: QuoteFormProps) {
  const [text, setText] = useState(initial?.text ?? '')
  const [author, setAuthor] = useState(initial?.author ?? '')
  const [source, setSource] = useState(initial?.source ?? '')
  const [sourceUrl, setSourceUrl] = useState(initial?.source_url ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(initial?.scene_tags ?? [])
  const [planId, setPlanId] = useState<number | null>(initial?.writing_plan_id ?? null)

  function toggleTag(v: string) {
    setSelectedTags(prev => prev.includes(v) ? prev.filter(t => t !== v) : [...prev, v])
  }

  async function handleSubmit() {
    if (!text.trim()) return
    await onSave({ text: text.trim(), author, source, source_url: sourceUrl, scene_tags: selectedTags, writing_plan_id: planId })
  }

  const flat = flattenTopics(plans)

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="金句原文…"
        rows={3}
        autoFocus
        className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-sm resize-none"
      />
      <div className="grid grid-cols-2 gap-2">
        <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="作者（可选）"
          className="px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs" />
        <input value={source} onChange={e => setSource(e.target.value)} placeholder="出处（可选）"
          className="px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs" />
      </div>
      <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="链接（可选）"
        className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs" />

      {/* Scene tags */}
      <div>
        <p className="text-xs text-zinc-500 mb-1.5">使用场景</p>
        <div className="flex flex-wrap gap-1.5">
          {SCENE_TAGS.map(t => (
            <button
              key={t.value}
              onClick={() => toggleTag(t.value)}
              className={cn(
                'text-xs px-2.5 py-1 rounded-full border transition-all',
                selectedTags.includes(t.value)
                  ? cn(t.color, 'border-transparent')
                  : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-300'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Plan association */}
      {flat.length > 0 && (
        <select
          value={planId ?? ''}
          onChange={e => setPlanId(e.target.value ? Number(e.target.value) : null)}
          className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent outline-none focus:border-indigo-400 text-xs text-zinc-600 dark:text-zinc-400"
        >
          <option value="">不关联写作方案</option>
          {flat.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      )}

      <div className="flex gap-2 pt-1">
        <Button onClick={handleSubmit} disabled={saving || !text.trim()} className="flex-1 gap-1">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {initial ? '保存修改' : '添加金句'}
        </Button>
        <Button variant="outline" onClick={onCancel}>取消</Button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function QuotesClient({
  initialQuotes,
  initialPlans,
}: {
  initialQuotes: Quote[]
  initialPlans: WritingPlan[]
}) {
  const [quotes, setQuotes] = useState<Quote[]>(initialQuotes)
  const [plans] = useState<WritingPlan[]>(initialPlans)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // New / edit form
  const [showForm, setShowForm] = useState(false)
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null)
  const [saving, setSaving] = useState(false)

  const planMap = Object.fromEntries(
    flattenTopics(plans).map(p => [p.id, p.title])
  )

  const filtered = quotes.filter(q => {
    const matchSearch = !search ||
      q.text.toLowerCase().includes(search.toLowerCase()) ||
      q.author.toLowerCase().includes(search.toLowerCase()) ||
      q.source.toLowerCase().includes(search.toLowerCase())
    const matchTag = !activeTag || q.scene_tags.includes(activeTag)
    return matchSearch && matchTag
  })

  async function handleRefresh() {
    setRefreshing(true)
    try {
      setQuotes(await getQuotes())
    } catch { toast.error('刷新失败') }
    finally { setRefreshing(false) }
  }

  async function handleCreate(data: QuoteCreate) {
    setSaving(true)
    try {
      const q = await createQuote(data as QuoteCreate)
      setQuotes(prev => [q, ...prev])
      setShowForm(false)
      toast.success('已添加')
    } catch { toast.error('添加失败') }
    finally { setSaving(false) }
  }

  async function handleUpdate(data: QuoteUpdate) {
    if (!editingQuote) return
    setSaving(true)
    try {
      const q = await updateQuote(editingQuote.id, data)
      setQuotes(prev => prev.map(x => x.id === q.id ? q : x))
      setEditingQuote(null)
      toast.success('已保存')
    } catch { toast.error('保存失败') }
    finally { setSaving(false) }
  }

  async function handleDelete(quote: Quote) {
    if (!confirm(`确定删除这条金句？`)) return
    try {
      await deleteQuote(quote.id)
      setQuotes(prev => prev.filter(q => q.id !== quote.id))
      toast.success('已删除')
    } catch { toast.error('删除失败') }
  }

  function openEdit(q: Quote) {
    setEditingQuote(q)
    setShowForm(false)
  }

  function closeForm() {
    setShowForm(false)
    setEditingQuote(null)
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Left: filters ──────────────────────────────────── */}
      <aside className="w-52 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <QuoteIcon className="w-4 h-4 text-indigo-500" />
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">金句库</span>
          <button onClick={handleRefresh} disabled={refreshing} className="ml-auto text-zinc-400 hover:text-zinc-600 disabled:opacity-40">
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>

        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">使用场景</p>
          <button
            onClick={() => setActiveTag('')}
            className={cn(
              'w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5 transition-colors',
              !activeTag ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
            )}
          >
            全部 <span className="text-zinc-400 ml-1">{quotes.length}</span>
          </button>
          {SCENE_TAGS.map(t => {
            const count = quotes.filter(q => q.scene_tags.includes(t.value)).length
            return (
              <button
                key={t.value}
                onClick={() => setActiveTag(activeTag === t.value ? '' : t.value)}
                className={cn(
                  'w-full text-left text-xs px-2 py-1.5 rounded-md mb-0.5 transition-colors flex items-center gap-2',
                  activeTag === t.value ? 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                )}
              >
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', t.color.split(' ')[0])} />
                {t.label}
                <span className="ml-auto text-zinc-400">{count}</span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Right: content ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex-shrink-0">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索金句、作者、出处…"
              className="w-full pl-8 pr-3 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-transparent text-xs outline-none focus:border-indigo-400"
            />
          </div>
          <span className="text-xs text-zinc-400">{filtered.length} 条</span>
          <Button size="sm" onClick={() => { setShowForm(true); setEditingQuote(null) }} className="gap-1 ml-auto">
            <Plus className="w-3.5 h-3.5" /> 添加金句
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* Inline new/edit form */}
          {(showForm || editingQuote) && (
            <div className="bg-white dark:bg-zinc-900 border border-indigo-200 dark:border-indigo-800 rounded-xl p-5 mb-6 shadow-sm">
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">
                {editingQuote ? '编辑金句' : '添加新金句'}
              </p>
              <QuoteForm
                initial={editingQuote ?? undefined}
                plans={plans}
                onSave={editingQuote ? (d => handleUpdate(d as QuoteUpdate)) : (d => handleCreate(d as QuoteCreate))}
                onCancel={closeForm}
                saving={saving}
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-400 gap-3">
              <QuoteIcon className="w-12 h-12 opacity-20" />
              <p className="text-sm">{search || activeTag ? '没有匹配的金句' : '还没有收录任何金句'}</p>
              {!search && !activeTag && (
                <Button size="sm" variant="outline" onClick={() => setShowForm(true)} className="gap-1">
                  <Plus className="w-3.5 h-3.5" /> 添加第一条
                </Button>
              )}
            </div>
          ) : (
            <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
              {filtered.map(q => (
                <div key={q.id} className="break-inside-avoid">
                  <QuoteCard
                    quote={q}
                    planMap={planMap}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
