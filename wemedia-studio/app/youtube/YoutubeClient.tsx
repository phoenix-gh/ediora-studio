'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { PlaySquare, RefreshCw, Plus, Trash2, Volume2, VolumeX, ExternalLink, Search, Pencil, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  YoutubeChannel, YoutubeVideo,
  getYoutubeChannels, getYoutubeVideos,
  addYoutubeChannel, updateYoutubeChannel, deleteYoutubeChannel,
  collectYoutube, collectYoutubeChannel,
} from '@/lib/api/youtube'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const DAYS_OPTIONS = [7, 14, 30, 90]
const PAGE_SIZE = 24

function fmtViews(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// ── Add Channel Dialog ─────────────────────────────────────────────────────────

function AddChannelDialog({ onAdd }: { onAdd: (channelId: string, group: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [channelId, setChannelId] = useState('')
  const [group, setGroup] = useState('未分组')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const id = channelId.trim()
    if (!id) return
    setLoading(true)
    try {
      await onAdd(id, group)
      setChannelId('')
      setGroup('未分组')
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" />
        订阅频道
      </Button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-wrap">
      <Input
        autoFocus
        value={channelId}
        onChange={e => setChannelId(e.target.value)}
        placeholder="Channel ID (如 UCrWhQHtbphf5j0Xj9ELvXPQ)"
        className="h-8 text-xs w-72"
      />
      <Input
        value={group}
        onChange={e => setGroup(e.target.value)}
        placeholder="分组"
        className="h-8 text-xs w-28"
      />
      <Button type="submit" size="sm" className="h-8 text-xs" disabled={loading || !channelId.trim()}>
        {loading ? '添加中…' : '确认'}
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setOpen(false)}>
        取消
      </Button>
    </form>
  )
}

// ── Channel Sidebar ────────────────────────────────────────────────────────────

function ChannelList({
  channels, selectedId, onSelect, onMute, onDelete, onCollect,
}: {
  channels: YoutubeChannel[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMute: (ch: YoutubeChannel) => Promise<void>
  onDelete: (ch: YoutubeChannel) => Promise<void>
  onCollect: (ch: YoutubeChannel) => Promise<void>
}) {
  return (
    <div className="space-y-0.5">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
          selectedId === null
            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium'
            : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900',
        )}
      >
        <PlaySquare className="w-4 h-4 flex-shrink-0 text-red-500" />
        <span className="truncate">全部频道</span>
        <span className="ml-auto text-[10px] text-zinc-400">{channels.length}</span>
      </button>
      {channels.map(ch => (
        <div
          key={ch.id}
          className={cn(
            'group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer',
            selectedId === ch.id
              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900',
            ch.muted && 'opacity-50',
          )}
          onClick={() => onSelect(ch.id)}
        >
          {ch.avatar_url ? (
            <img src={ch.avatar_url} alt="" className="w-6 h-6 rounded-full flex-shrink-0 object-cover" />
          ) : (
            <div className="w-6 h-6 rounded-full flex-shrink-0 bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center">
              <PlaySquare className="w-3.5 h-3.5 text-zinc-400" />
            </div>
          )}
          <span className="truncate flex-1 min-w-0">{ch.name}</span>
          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              onClick={e => { e.stopPropagation(); onCollect(ch) }}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              title="立即采集"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
            <button
              onClick={e => { e.stopPropagation(); onMute(ch) }}
              className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              title={ch.muted ? '取消静音' : '静音'}
            >
              {ch.muted ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
            </button>
            <button
              onClick={e => { e.stopPropagation(); onDelete(ch) }}
              className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-red-500 transition-colors"
              title="取消订阅"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Channel Header ─────────────────────────────────────────────────────────────

function ChannelHeader({
  channel,
  onNoteChange,
}: {
  channel: YoutubeChannel
  onNoteChange: (note: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(channel.note)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await onNoteChange(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setDraft(channel.note)
    setEditing(false)
  }

  const desc = channel.description_cn || channel.description

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 px-6 py-4">
      <div className="flex items-start gap-4">
        {channel.avatar_url ? (
          <img
            src={channel.avatar_url}
            alt={channel.name}
            className="w-14 h-14 rounded-full flex-shrink-0 object-cover bg-zinc-200 dark:bg-zinc-800"
          />
        ) : (
          <div className="w-14 h-14 rounded-full flex-shrink-0 bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
            <PlaySquare className="w-7 h-7 text-zinc-400" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <a
              href={`https://www.youtube.com/channel/${channel.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-semibold text-zinc-900 dark:text-zinc-100 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            >
              {channel.name}
            </a>
            <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
            {channel.group !== '未分组' && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-500">
                {channel.group}
              </span>
            )}
          </div>

          {desc && (
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
              {desc}
            </p>
          )}

          {/* Note */}
          <div className="mt-2">
            {editing ? (
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder="添加备注…"
                  className="h-7 text-xs flex-1 max-w-sm"
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSave()
                    if (e.key === 'Escape') handleCancel()
                  }}
                />
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-950 text-green-600 transition-colors"
                  title="保存"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleCancel}
                  className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 transition-colors"
                  title="取消"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setDraft(channel.note); setEditing(true) }}
                className="flex items-center gap-1.5 text-[12px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors group/note"
              >
                <Pencil className="w-3 h-3 opacity-0 group-hover/note:opacity-100 transition-opacity" />
                {channel.note
                  ? <span className="text-zinc-600 dark:text-zinc-300">{channel.note}</span>
                  : <span className="italic">添加备注…</span>
                }
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Video Card ─────────────────────────────────────────────────────────────────

function VideoCard({
  video,
  channels,
}: {
  video: YoutubeVideo
  channels: YoutubeChannel[]
}) {
  const channel = channels.find(c => c.id === video.channel_id)

  return (
    <a
      href={video.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col rounded-xl overflow-hidden hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
    >
      {/* Thumbnail — 16:9 */}
      <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-zinc-100 dark:bg-zinc-800">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <PlaySquare className="w-10 h-10 text-zinc-300" />
          </div>
        )}
      </div>

      {/* Info row */}
      <div className="flex gap-2.5 pt-2.5 px-0.5 pb-1">
        {/* Channel avatar */}
        <div className="flex-shrink-0 pt-0.5">
          {channel?.avatar_url ? (
            <img
              src={channel.avatar_url}
              alt=""
              className="w-8 h-8 rounded-full object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center">
              <PlaySquare className="w-4 h-4 text-zinc-400" />
            </div>
          )}
        </div>

        {/* Text */}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug">
            {video.title}
          </p>
          <div className="mt-1 space-y-0.5">
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
              {video.channel_name}
            </p>
            <p className="text-[11px] text-zinc-400">
              {video.views > 0 && `${fmtViews(video.views)} 次观看 · `}
              {fmtDate(video.published_at)}
            </p>
          </div>
        </div>
      </div>
    </a>
  )
}

// ── Main Client ────────────────────────────────────────────────────────────────

export function YoutubeClient({
  initialChannels,
  initialVideos,
}: {
  initialChannels: YoutubeChannel[]
  initialVideos: YoutubeVideo[]
}) {
  const [channels, setChannels] = useState(initialChannels)
  const [videos, setVideos] = useState(initialVideos)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [days, setDays] = useState(30)
  const [search, setSearch] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const selectedChannel = selectedChannelId
    ? channels.find(c => c.id === selectedChannelId) ?? null
    : null

  const refreshVideos = useCallback(async (opts?: { channelId?: string | null; daysVal?: number }) => {
    setLoading(true)
    try {
      const cid = opts?.channelId !== undefined ? opts.channelId : selectedChannelId
      const d = opts?.daysVal ?? days
      const data = await getYoutubeVideos({
        channel_id: cid ?? undefined,
        days: d,
        limit: 200,
        search: search || undefined,
      })
      setVideos(data)
      setVisibleCount(PAGE_SIZE)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [selectedChannelId, days, search])

  async function handleAdd(channelId: string, group: string) {
    try {
      await addYoutubeChannel(channelId, group)
      toast.success('订阅成功，正在后台采集视频…')
      const fresh = await getYoutubeChannels()
      setChannels(fresh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '订阅失败')
      throw e
    }
  }

  async function handleMute(ch: YoutubeChannel) {
    try {
      const updated = await updateYoutubeChannel(ch.id, { muted: !ch.muted })
      setChannels(prev => prev.map(c => c.id === ch.id ? updated : c))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  async function handleDelete(ch: YoutubeChannel) {
    if (!confirm(`取消订阅「${ch.name}」并删除其所有视频？`)) return
    try {
      await deleteYoutubeChannel(ch.id)
      toast.success(`已取消订阅 ${ch.name}`)
      const fresh = await getYoutubeChannels()
      setChannels(fresh)
      if (selectedChannelId === ch.id) {
        setSelectedChannelId(null)
        await refreshVideos({ channelId: null })
      } else {
        await refreshVideos()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function handleCollectChannel(ch: YoutubeChannel) {
    try {
      await collectYoutubeChannel(ch.id)
      toast.success(`${ch.name} 采集已启动`)
      setTimeout(() => refreshVideos(), 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    }
  }

  async function handleCollectAll() {
    setCollecting(true)
    try {
      await collectYoutube()
      toast.success('全量采集已启动，稍后刷新查看')
      setTimeout(() => refreshVideos(), 5000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  async function handleSelectChannel(id: string | null) {
    setSelectedChannelId(id)
    await refreshVideos({ channelId: id })
  }

  async function handleDaysChange(d: number) {
    setDays(d)
    await refreshVideos({ daysVal: d })
  }

  async function handleNoteChange(note: string) {
    if (!selectedChannelId) return
    try {
      const updated = await updateYoutubeChannel(selectedChannelId, { note })
      setChannels(prev => prev.map(c => c.id === selectedChannelId ? updated : c))
      toast.success('备注已保存')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
      throw e
    }
  }

  const filtered = useMemo(() => {
    let list = videos
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(v =>
        v.title.toLowerCase().includes(q) ||
        v.channel_name.toLowerCase().includes(q)
      )
    }
    return [...list].sort((a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    )
  }, [videos, search])

  const visibleVideos = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && hasMore) setVisibleCount(c => c + PAGE_SIZE) },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore])

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 border-r border-zinc-200 dark:border-zinc-800 flex flex-col flex-shrink-0">
        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">订阅频道</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <ChannelList
            channels={channels}
            selectedId={selectedChannelId}
            onSelect={handleSelectChannel}
            onMute={handleMute}
            onDelete={handleDelete}
            onCollect={handleCollectChannel}
          />
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Channel header — shown when a specific channel is selected */}
        {selectedChannel && (
          <ChannelHeader channel={selectedChannel} onNoteChange={handleNoteChange} />
        )}

        {/* Toolbar */}
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              {!selectedChannel && <PlaySquare className="w-4 h-4 text-red-500" />}
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {selectedChannel ? selectedChannel.name : 'YouTube 订阅'}
              </span>
              <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
                {filtered.length} 个视频
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                <Input
                  value={search}
                  onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE) }}
                  placeholder="搜索标题/频道"
                  className="h-8 text-xs pl-8 w-44"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={handleCollectAll}
                disabled={collecting}
              >
                <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />
                {collecting ? '采集中…' : '立即采集'}
              </Button>
              <AddChannelDialog onAdd={handleAdd} />
            </div>
          </div>

          {/* Days filter */}
          <div className="flex items-center gap-1 mt-2.5">
            <span className="text-xs text-zinc-400">最近</span>
            {DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => handleDaysChange(d)}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
                  days === d
                    ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium'
                    : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                {d}天
              </button>
            ))}
          </div>
        </div>

        {/* Video grid */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-zinc-400">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-400">
              <PlaySquare className="w-10 h-10 opacity-20 text-red-500" />
              <p className="text-sm">
                {channels.length === 0
                  ? '点击「订阅频道」添加 YouTube 频道'
                  : '暂无视频，点击「立即采集」获取最新内容'}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-x-4 gap-y-6">
                {visibleVideos.map(video => (
                  <VideoCard key={video.id} video={video} channels={channels} />
                ))}
              </div>
              <div ref={sentinelRef} className="flex items-center justify-center py-6">
                {hasMore && (
                  <span className="text-xs text-zinc-400">加载中…</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
