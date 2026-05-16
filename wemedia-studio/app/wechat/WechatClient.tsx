'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { MessageSquare, Plus, Trash2, ExternalLink, Search, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { WechatArticle, getWechatArticles, addWechatArticle, deleteWechatArticle } from '@/lib/api/wechat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 40

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ── Add Article Bar ────────────────────────────────────────────────────────────

function AddBar({ onAdd }: { onAdd: (url: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const u = url.trim()
    if (!u) return
    setLoading(true)
    try {
      await onAdd(u)
      setUrl('')
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" />
        添加文章
      </Button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <Input
        ref={inputRef}
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="粘贴微信文章链接…"
        className="h-8 text-xs w-96"
        onKeyDown={e => e.key === 'Escape' && setOpen(false)}
      />
      <Button type="submit" size="sm" className="h-8 text-xs" disabled={loading || !url.trim()}>
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '保存'}
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-8 text-xs px-2"
        onClick={() => { setUrl(''); setOpen(false) }}>
        <X className="w-3.5 h-3.5" />
      </Button>
    </form>
  )
}

// ── Article Card ───────────────────────────────────────────────────────────────

function ArticleCard({ article, onDelete }: { article: WechatArticle; onDelete: () => void }) {
  return (
    <div className="group flex gap-3 py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      {article.cover_url && (
        <a href={article.url} target="_blank" rel="noopener noreferrer"
          className="flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800">
          <img src={article.cover_url} alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        </a>
      )}

      <div className="flex-1 min-w-0">
        <a href={article.url} target="_blank" rel="noopener noreferrer"
          className="block text-[13px] font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug
                     hover:text-green-700 dark:hover:text-green-400 transition-colors">
          {article.title}
        </a>
        {article.digest && (
          <p className="mt-1 text-[11px] text-zinc-400 line-clamp-1">{article.digest}</p>
        )}
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
          {article.account_name && (
            <>
              <MessageSquare className="w-3 h-3 text-green-500 flex-shrink-0" />
              <span className="text-zinc-500 truncate max-w-[120px]">{article.account_name}</span>
              <span>·</span>
            </>
          )}
          <span>{fmtDate(article.published_at)}</span>
          <a href={article.url} target="_blank" rel="noopener noreferrer"
            className="ml-1 opacity-0 group-hover:opacity-60 transition-opacity">
            <ExternalLink className="w-3 h-3" />
          </a>
          <button
            onClick={onDelete}
            className="ml-auto opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 dark:hover:bg-red-950 text-red-400 transition-all"
            title="删除">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Account filter pills ────────────────────────────────────────────────────────

function AccountPills({
  accounts, selected, onSelect,
}: {
  accounts: string[]
  selected: string | null
  onSelect: (a: string | null) => void
}) {
  if (accounts.length === 0) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'px-2.5 py-0.5 rounded-full text-xs transition-colors',
          selected === null
            ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 font-medium'
            : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
        )}
      >
        全部
      </button>
      {accounts.map(a => (
        <button
          key={a}
          onClick={() => onSelect(a === selected ? null : a)}
          className={cn(
            'px-2.5 py-0.5 rounded-full text-xs transition-colors',
            selected === a
              ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 font-medium'
              : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
          )}
        >
          {a}
        </button>
      ))}
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function WechatClient({ initialArticles }: { initialArticles: WechatArticle[] }) {
  const [articles, setArticles] = useState(initialArticles)
  const [search, setSearch] = useState('')
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const accounts = useMemo(() => {
    const names = [...new Set(articles.map(a => a.account_name).filter(Boolean))]
    return names.sort()
  }, [articles])

  const filtered = useMemo(() => {
    let list = articles
    if (selectedAccount) list = list.filter(a => a.account_name === selectedAccount)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.account_name.toLowerCase().includes(q)
      )
    }
    return list
  }, [articles, search, selectedAccount])

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && hasMore) setVisibleCount(c => c + PAGE_SIZE) },
      { rootMargin: '200px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore])

  async function handleAdd(url: string) {
    try {
      const art = await addWechatArticle(url)
      setArticles(prev => {
        if (prev.some(a => a.id === art.id)) return prev
        return [art, ...prev]
      })
      toast.success(`已保存：${art.title.slice(0, 30)}…`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '添加失败')
      throw e
    }
  }

  async function handleDelete(article: WechatArticle) {
    try {
      await deleteWechatArticle(article.id)
      setArticles(prev => prev.filter(a => a.id !== article.id))
      toast.success('已删除')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3 flex-shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-green-500" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">公众号文章</span>
            <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
              {filtered.length} 篇
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
              <Input
                value={search}
                onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE) }}
                placeholder="搜索标题/公众号"
                className="h-8 text-xs pl-8 w-44"
              />
            </div>
            <AddBar onAdd={handleAdd} />
          </div>
        </div>

        {accounts.length > 0 && (
          <div className="mt-2.5">
            <AccountPills
              accounts={accounts}
              selected={selectedAccount}
              onSelect={a => { setSelectedAccount(a); setVisibleCount(PAGE_SIZE) }}
            />
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-400">
            <MessageSquare className="w-10 h-10 opacity-20 text-green-500" />
            <p className="text-sm">
              {articles.length === 0
                ? '点击「添加文章」，粘贴微信公众号文章链接'
                : '没有符合条件的文章'}
            </p>
          </div>
        ) : (
          <>
            <div className="max-w-2xl">
              {visible.map(art => (
                <ArticleCard key={art.id} article={art} onDelete={() => handleDelete(art)} />
              ))}
            </div>
            <div ref={sentinelRef} className="py-4">
              {hasMore && <span className="text-xs text-zinc-400">加载中…</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
