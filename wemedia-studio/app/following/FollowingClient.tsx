'use client'

import { useState, useMemo, useCallback } from 'react'
import { FollowedAccount, Post } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { AddAccountDialog } from '@/components/features/AddAccountDialog'
import {
  Flame, Star, VolumeX, VolumeOff, Users, MessageSquare,
  Repeat2, Heart, Clock, Zap, Plus, RefreshCw, Trash2, ExternalLink,
  ChevronDown, ChevronUp,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

function formatRelativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)}m`
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function formatNumber(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const GROUP_ORDER = ['AI 研究员', 'AI 公司', 'AI 创业', '开源大佬', '开源社区', '科技媒体', '学术', '未分组']

const avatarColors: Record<string, string> = {
  'AI 研究员': 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
  'AI 公司': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  'AI 创业': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  '开源大佬': 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  '开源社区': 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  '科技媒体': 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
  '学术': 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  '未分组': 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

const CONTENT_COLLAPSE_THRESHOLD = 200

function PostCard({ post, account }: { post: Post; account: FollowedAccount | undefined }) {
  const [expanded, setExpanded] = useState(false)

  if (!account) return null

  const hasTitle = post.title.trim().length > 0
  const hasContent = post.content.trim().length > 0
  const isLong = post.content.length > CONTENT_COLLAPSE_THRESHOLD

  return (
    <article className={cn(
      'px-6 py-4 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30 transition-colors',
      post.isAbnormallyPopular && 'bg-red-50/30 dark:bg-red-950/10'
    )}>
      <div className="flex gap-3">
        <div className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5',
          avatarColors[account.group] || 'bg-zinc-100 text-zinc-600'
        )}>
          {account.avatar.slice(0, 2)}
        </div>
        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{account.name}</span>
            <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 text-zinc-400 border-zinc-200 dark:border-zinc-700">
              {account.platform}
            </Badge>
            {post.isAbnormallyPopular && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium text-red-500 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 px-1.5 py-0.5 rounded-full">
                <Zap className="w-2.5 h-2.5" />爆火
              </span>
            )}
            <span className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400 flex-shrink-0">
              <Clock className="w-3 h-3" />
              {formatRelativeTime(post.publishedAt)}
            </span>
          </div>

          {/* Title (prominent) */}
          {hasTitle && (
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 leading-snug mb-1.5">
              {post.title}
            </p>
          )}

          {/* Body content */}
          {hasContent && (
            <div>
              <p className={cn(
                'text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed',
                !expanded && isLong && 'line-clamp-3'
              )}>
                {post.content}
              </p>
              {isLong && (
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="mt-1 flex items-center gap-0.5 text-[11px] text-zinc-400 hover:text-indigo-500 transition-colors"
                >
                  {expanded ? <><ChevronUp className="w-3 h-3" />收起</> : <><ChevronDown className="w-3 h-3" />展开全文</>}
                </button>
              )}
            </div>
          )}

          {/* Footer metrics */}
          <div className="flex items-center gap-4 mt-2.5">
            <span className="flex items-center gap-1 text-xs text-zinc-400">
              <Heart className="w-3.5 h-3.5" />{formatNumber(post.metrics.likes)}
            </span>
            <span className="flex items-center gap-1 text-xs text-zinc-400">
              <Repeat2 className="w-3.5 h-3.5" />{formatNumber(post.metrics.reposts)}
            </span>
            <span className="flex items-center gap-1 text-xs text-zinc-400">
              <MessageSquare className="w-3.5 h-3.5" />{formatNumber(post.metrics.comments)}
            </span>
            {post.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-xs text-zinc-400 hover:text-indigo-500 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                原文
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

interface Props {
  accounts: FollowedAccount[]
  posts: Post[]
}

export function FollowingClient({ accounts: initial, posts: initialPosts }: Props) {
  const [accounts, setAccounts] = useState(initial)
  const [posts, setPosts] = useState(initialPosts)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [hotOnly, setHotOnly] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [collecting, setCollecting] = useState<string | null>(null)

  const groups = useMemo(() => {
    const map: Record<string, FollowedAccount[]> = {}
    accounts.forEach(a => {
      if (!map[a.group]) map[a.group] = []
      map[a.group].push(a)
    })
    return GROUP_ORDER.filter(g => map[g]).map(g => ({ name: g, accounts: map[g] }))
  }, [accounts])

  const filteredPosts = useMemo(() => {
    let result = posts
    if (selectedAccountId) {
      result = result.filter(p => p.accountId === selectedAccountId)
    } else if (selectedGroup) {
      const ids = accounts.filter(a => a.group === selectedGroup).map(a => a.id)
      result = result.filter(p => ids.includes(p.accountId))
    }
    if (hotOnly) result = result.filter(p => p.isAbnormallyPopular)
    return result
  }, [posts, selectedAccountId, selectedGroup, hotOnly, accounts])

  const reloadPosts = useCallback(async () => {
    const res = await fetch(`${API}/posts?limit=100`)
    if (!res.ok) return
    const raw = await res.json()
    setPosts(raw.map((p: Record<string, unknown>) => ({
      id: p.id,
      accountId: p.account_id,
      title: (p.title as string) ?? '',
      content: p.content,
      url: p.url ?? '',
      publishedAt: p.published_at,
      metrics: p.metrics,
      isAbnormallyPopular: p.is_abnormally_popular,
    })))
  }, [])

  const reloadAccounts = useCallback(async () => {
    const res = await fetch(`${API}/accounts`)
    if (!res.ok) return
    const raw = await res.json()
    setAccounts(raw.map((a: Record<string, unknown>) => ({
      id: a.id, name: a.name, avatar: a.avatar,
      platform: a.platform, group: a.group,
      priority: a.priority, muted: a.muted,
    })))
  }, [])

  async function handleCollect(accountId: string) {
    setCollecting(accountId)
    try {
      const res = await fetch(`${API}/collect/account/${accountId}`, { method: 'POST' })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      toast.success(`采集完成，新增 ${data.new_posts} 条`)
      if (data.new_posts > 0) await reloadPosts()
    } catch (e) {
      toast.error(`采集失败：${e}`)
    } finally {
      setCollecting(null)
    }
  }

  async function handleMute(account: FollowedAccount) {
    const res = await fetch(`${API}/accounts/${account.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: !account.muted }),
    })
    if (!res.ok) return
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, muted: !a.muted } : a))
    toast(account.muted ? '已取消静音' : '已静音')
  }

  async function handleDelete(account: FollowedAccount) {
    const res = await fetch(`${API}/accounts/${account.id}`, { method: 'DELETE' })
    if (!res.ok) return
    setAccounts(prev => prev.filter(a => a.id !== account.id))
    if (selectedAccountId === account.id) setSelectedAccountId(null)
    toast(`已移除「${account.name}」`)
  }

  const hotCount = posts.filter(p => p.isAbnormallyPopular).length

  return (
    <>
      <div className="flex h-full overflow-hidden">
        {/* 左栏：账号列表 */}
        <aside className="w-64 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">关注动态</h2>
              <p className="text-[11px] text-zinc-400">{accounts.filter(a => !a.muted).length} 个关注 · {hotCount} 条爆火</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 flex-shrink-0"
              onClick={() => setDialogOpen(true)}
              title="添加订阅"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {/* 全部 */}
            <button
              onClick={() => { setSelectedAccountId(null); setSelectedGroup(null) }}
              className={cn(
                'w-full flex items-center gap-2.5 px-4 py-2 text-xs transition-colors',
                !selectedAccountId && !selectedGroup
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              )}
            >
              <Users className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="font-medium">全部动态</span>
              <span className="ml-auto text-zinc-400">{posts.length}</span>
            </button>

            <div className="mt-1">
              {groups.map(({ name, accounts: groupAccounts }) => (
                <div key={name}>
                  <button
                    onClick={() => { setSelectedGroup(selectedGroup === name ? null : name); setSelectedAccountId(null) }}
                    className={cn(
                      'w-full flex items-center gap-2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                      selectedGroup === name
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
                    )}
                  >
                    {name}
                    <span className="ml-auto font-normal normal-case tracking-normal text-zinc-400">{groupAccounts.length}</span>
                  </button>

                  {groupAccounts.map(account => {
                    const accountPosts = posts.filter(p => p.accountId === account.id)
                    const hasHot = accountPosts.some(p => p.isAbnormallyPopular)
                    const isCollecting = collecting === account.id
                    return (
                      <div
                        key={account.id}
                        className={cn(
                          'group relative flex items-center gap-2 px-4 py-1.5 transition-colors cursor-pointer',
                          selectedAccountId === account.id
                            ? 'bg-indigo-50 dark:bg-indigo-950/50'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                          account.muted && 'opacity-40'
                        )}
                        onClick={() => { setSelectedAccountId(selectedAccountId === account.id ? null : account.id); setSelectedGroup(null) }}
                      >
                        <div className={cn(
                          'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0',
                          avatarColors[account.group] || 'bg-zinc-100 text-zinc-600'
                        )}>
                          {account.avatar.slice(0, 2)}
                        </div>
                        <span className={cn(
                          'flex-1 text-xs truncate',
                          selectedAccountId === account.id ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-600 dark:text-zinc-400'
                        )}>
                          {account.name}
                        </span>

                        {/* 状态图标（非 hover 时显示） */}
                        {!isCollecting && (
                          <span className="flex items-center gap-0.5 group-hover:opacity-0 transition-opacity">
                            {hasHot && !account.muted && <Flame className="w-3 h-3 text-red-400" />}
                            {account.priority === 'high' && !account.muted && !hasHot && <Star className="w-3 h-3 text-amber-400 fill-amber-400" />}
                            {account.muted && <VolumeX className="w-3 h-3 text-zinc-400" />}
                          </span>
                        )}

                        {/* 操作按钮（绝对定位，hover 时叠加在右侧） */}
                        <span
                          className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={e => e.stopPropagation()}
                        >
                          <button
                            onClick={() => handleCollect(account.id)}
                            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-700"
                            title="立即采集"
                          >
                            <RefreshCw className={cn('w-3 h-3', isCollecting && 'animate-spin')} />
                          </button>
                          <button
                            onClick={() => handleMute(account)}
                            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-700"
                            title={account.muted ? '取消静音' : '静音'}
                          >
                            {account.muted ? <VolumeOff className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                          </button>
                          <button
                            onClick={() => handleDelete(account)}
                            className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-zinc-400 hover:text-red-500"
                            title="移除订阅"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>

            {/* 空状态 */}
            {accounts.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-xs text-zinc-400 mb-3">还没有订阅源</p>
                <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => setDialogOpen(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  添加订阅
                </Button>
              </div>
            )}
          </div>
        </aside>

        {/* 右栏：动态流 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-shrink-0 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center gap-4">
            {selectedAccountId ? (() => {
              const a = accounts.find(x => x.id === selectedAccountId)!
              return (
                <div className="flex items-center gap-2">
                  <div className={cn('w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold', avatarColors[a?.group] || 'bg-zinc-100')}>
                    {a?.avatar?.slice(0, 2)}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{a?.name}</p>
                    <p className="text-[11px] text-zinc-400">{a?.group} · {a?.platform}</p>
                  </div>
                </div>
              )
            })() : (
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{selectedGroup ?? '全部动态'}</p>
                <p className="text-[11px] text-zinc-400">{filteredPosts.length} 条</p>
              </div>
            )}

            <div className="ml-auto flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer">
                <Switch checked={hotOnly} onCheckedChange={setHotOnly} className="scale-75" />
                <Flame className="w-3.5 h-3.5 text-red-400" />
                仅爆火
              </label>
              {selectedAccountId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  disabled={!!collecting}
                  onClick={() => handleCollect(selectedAccountId)}
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', collecting === selectedAccountId && 'animate-spin')} />
                  立即采集
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredPosts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center gap-3">
                <MessageSquare className="w-10 h-10 text-zinc-300 dark:text-zinc-700" />
                <p className="text-sm font-medium text-zinc-500">暂无动态</p>
                <p className="text-xs text-zinc-400">
                  {accounts.length === 0 ? '先添加订阅源' : '点击账号旁的刷新图标立即采集'}
                </p>
                {accounts.length === 0 && (
                  <Button size="sm" variant="outline" className="text-xs h-7 mt-1" onClick={() => setDialogOpen(true)}>
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    添加订阅
                  </Button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filteredPosts.map(post => (
                  <PostCard key={post.id} post={post} account={accounts.find(a => a.id === post.accountId)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <AddAccountDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdded={reloadAccounts}
      />
    </>
  )
}
