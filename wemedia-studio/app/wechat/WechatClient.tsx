'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import {
  MessageSquare, Trash2, Search, Loader2,
  ScanLine, LogOut, RefreshCw, Settings, UserPlus,
  DownloadCloud, ChevronDown, Check,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  WechatArticle, getWechatArticles, getWechatArticle, deleteWechatArticle,
  WechatAuthState, getWechatAuthState, startWechatQrcode, pollWechatScan,
  finalizeWechatLogin, logoutWechat,
  WechatAccountCandidate, WechatSubscribedAccount,
  searchWechatAccounts, listSubscribedAccounts,
  subscribeWechatAccount, unsubscribeWechatAccount, syncWechatAccount,
  WechatCollectStatus, startWechatCollectAll, getWechatCollectStatus,
  wechatImg,
} from '@/lib/api/wechat'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'
import { PushToStudioPopover } from '@/components/features/PushToStudioPopover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { fmtFullDate } from '@/lib/format'
import { useInfiniteScroll } from '@/lib/use-infinite-scroll'
import { useMediaQuery } from '@/lib/use-media-query'
import { ResponsiveArticleReader, ReaderMeta } from '@/components/features/ArticleReader'

const PAGE_SIZE = 40

// ── Login dialog (QR scan) ─────────────────────────────────────────────────────

const SCAN_STATUS_TEXT: Record<number, string> = {
  0: '请使用微信扫码',
  1: '已确认，正在登录…',
  2: '二维码已刷新，请重新扫码',
  3: '二维码已刷新，请重新扫码',
  4: '扫码成功，请在微信上确认登录',
  5: '该账号尚未绑定邮箱',
  6: '扫码成功，请在微信上确认登录',
}

function LoginDialog({
  open, onOpenChange, onLoggedIn,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onLoggedIn: () => void
}) {
  const [qr, setQr] = useState<string>('')
  const [token, setToken] = useState<string>('')
  const [msg, setMsg] = useState<string>('正在获取二维码…')
  const [busy, setBusy] = useState(true)
  const stopRef = useRef(false)

  const start = useCallback(async () => {
    stopRef.current = false
    setQr(''); setMsg('正在获取二维码…'); setBusy(true)
    try {
      const { qr_data_url, login_token } = await startWechatQrcode()
      setQr(qr_data_url)
      setToken(login_token)
      setMsg(SCAN_STATUS_TEXT[0])
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '获取二维码失败')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      stopRef.current = true
      return
    }
    stopRef.current = false
    void startWechatQrcode()
      .then(({ qr_data_url, login_token }) => {
        if (stopRef.current) return
        setQr(qr_data_url)
        setToken(login_token)
        setMsg(SCAN_STATUS_TEXT[0])
      })
      .catch(error => {
        if (!stopRef.current) {
          setMsg(error instanceof Error ? error.message : '获取二维码失败')
        }
      })
      .finally(() => {
        if (!stopRef.current) setBusy(false)
      })
    return () => { stopRef.current = true }
  }, [open])

  // poll loop
  useEffect(() => {
    if (!open || !token) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (stopRef.current) return
      try {
        const r = await pollWechatScan(token)
        if (stopRef.current) return
        setMsg(SCAN_STATUS_TEXT[r.status] ?? `状态码 ${r.status}`)
        if (r.status === 1) {
          setBusy(true)
          try {
            await finalizeWechatLogin(token)
            toast.success('公众平台登录成功')
            stopRef.current = true
            onLoggedIn()
            onOpenChange(false)
          } catch (e) {
            setMsg(e instanceof Error ? e.message : '登录失败')
            setBusy(false)
          }
          return
        }
        if (r.status === 2 || r.status === 3) {
          // refresh QR
          start()
          return
        }
        if (!stopRef.current) timer = setTimeout(tick, 2000)
      } catch {
        if (!stopRef.current) timer = setTimeout(tick, 3000)
      }
    }
    timer = setTimeout(tick, 2000)
    return () => { if (timer) clearTimeout(timer) }
  }, [open, token, start, onLoggedIn, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>登录微信公众平台</DialogTitle>
          <DialogDescription>
            用微信扫描二维码后，在手机上确认登录。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center py-2 gap-3">
          <div className="size-64 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900 rounded-md border border-zinc-200 dark:border-zinc-800">
            {busy && !qr ? (
              <Loader2 className="w-7 h-7 animate-spin text-zinc-400" />
            ) : qr ? (
              <img src={qr} alt="qrcode" className="w-full h-full object-contain p-2" />
            ) : (
              <ScanLine className="w-10 h-10 text-zinc-400 opacity-40" />
            )}
          </div>
          <p className="text-xs text-zinc-500 min-h-[1.25rem]">{msg}</p>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5"
            onClick={start} disabled={busy}>
            <RefreshCw className="w-3 h-3" />
            刷新二维码
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Manage subscriptions dialog ─────────────────────────────────────────────

function SubscriptionsDialog({
  open, onOpenChange, onChanged,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const [q, setQ] = useState('')
  const [candidates, setCandidates] = useState<WechatAccountCandidate[]>([])
  const [subscribed, setSubscribed] = useState<WechatSubscribedAccount[]>([])
  const [searching, setSearching] = useState(false)
  const [actingBiz, setActingBiz] = useState<string | null>(null)

  const refreshSubscribed = useCallback(async () => {
    try {
      const items = await listSubscribedAccounts()
      setSubscribed(items)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载订阅失败')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void listSubscribedAccounts()
      .then(setSubscribed)
      .catch(error => toast.error(error instanceof Error ? error.message : '加载订阅失败'))
  }, [open])

  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault()
    if (!q.trim()) return
    setSearching(true)
    try {
      const items = await searchWechatAccounts(q.trim(), 0, 5)
      setCandidates(items)
      if (items.length === 0) toast.info('没有找到匹配的公众号')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  async function doSubscribe(c: WechatAccountCandidate) {
    setActingBiz(c.fakeid)
    try {
      await subscribeWechatAccount({
        fakeid: c.fakeid, nickname: c.nickname,
        alias: c.alias, avatar: c.round_head_img,
      })
      toast.success(`已订阅：${c.nickname}`)
      await refreshSubscribed()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '订阅失败')
    } finally {
      setActingBiz(null)
    }
  }

  async function doUnsubscribe(a: WechatSubscribedAccount) {
    setActingBiz(a.biz)
    try {
      await unsubscribeWechatAccount(a.biz)
      toast.success(`已取消订阅：${a.name}`)
      await refreshSubscribed()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '取消订阅失败')
    } finally {
      setActingBiz(null)
    }
  }

  async function doSync(a: WechatSubscribedAccount) {
    setActingBiz(a.biz)
    try {
      const r = await syncWechatAccount(a.biz, 1)
      const bodySummary = `正文成功 ${r.body_fetched} 篇，失败 ${r.body_failed} 篇`
      if (r.list_error) {
        toast.warning(`${a.name}：${r.list_error}；${bodySummary}`)
      } else if (r.body_failed) {
        toast.warning(`${a.name}：扫描 ${r.total_seen} 篇，新增 ${r.new_articles} 篇；${bodySummary}`)
      } else {
        toast.success(`${a.name}：扫描 ${r.total_seen} 篇，新增 ${r.new_articles} 篇；${bodySummary}`)
      }
      await refreshSubscribed()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '同步失败')
    } finally {
      setActingBiz(null)
    }
  }

  const subscribedIds = useMemo(() => new Set(subscribed.map(s => s.biz)), [subscribed])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>订阅管理 · 公众号</DialogTitle>
          <DialogDescription>
            搜索后订阅，系统每 15 分钟自动同步最新文章；也可在下方手动同步。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={doSearch} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <Input value={q} onChange={e => setQ(e.target.value)}
              placeholder="输入公众号名称…" className="h-8 text-xs pl-8" />
          </div>
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={searching || !q.trim()}>
            {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '搜索'}
          </Button>
        </form>

        {candidates.length > 0 && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-md max-h-44 overflow-y-auto">
            {candidates.map(c => (
              <div key={c.fakeid}
                className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                {c.round_head_img && (
                  <img src={wechatImg(c.round_head_img)} alt="" referrerPolicy="no-referrer"
                    className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{c.nickname}</div>
                  {c.alias && <div className="text-[11px] text-zinc-400 truncate">{c.alias}</div>}
                </div>
                {subscribedIds.has(c.fakeid) ? (
                  <span className="text-[11px] text-zinc-400">已订阅</span>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
                    disabled={actingBiz === c.fakeid}
                    onClick={() => doSubscribe(c)}>
                    {actingBiz === c.fakeid
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <UserPlus className="w-3 h-3" />}
                    订阅
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <div>
          <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1.5 px-0.5">
            已订阅 · {subscribed.length}
          </div>
          {subscribed.length === 0 ? (
            <div className="text-xs text-zinc-400 py-6 text-center border border-dashed rounded-md">
              暂无订阅。搜索公众号后点击「订阅」开始自动同步。
            </div>
          ) : (
            <div className="border border-zinc-200 dark:border-zinc-800 rounded-md max-h-60 overflow-y-auto">
              {subscribed.map(a => (
                <div key={a.biz}
                  className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                  {a.avatar_url && (
                    <img src={wechatImg(a.avatar_url)} alt="" referrerPolicy="no-referrer"
                      className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{a.name}</div>
                    <div className="text-[11px] text-zinc-400 truncate">
                      {a.last_collected_at ? `最近同步：${fmtFullDate(a.last_collected_at)}` : '尚未同步'}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 px-2"
                    disabled={actingBiz === a.biz}
                    onClick={() => doSync(a)}>
                    {actingBiz === a.biz
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <RefreshCw className="w-3 h-3" />}
                    同步
                  </Button>
                  <Button size="sm" variant="ghost"
                    className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                    disabled={actingBiz === a.biz}
                    onClick={() => doUnsubscribe(a)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Auth pill ──────────────────────────────────────────────────────────────────

interface AuthPillProps {
  state: WechatAuthState | null
  onLogin: () => void
  onLogout: () => void
}

export function AuthPill(props: AuthPillProps) {
  const clockIdentity = `${props.state?.logged_in ?? 'loading'}:${props.state?.expires_at ?? ''}`
  return <AuthPillClock key={clockIdentity} {...props} />
}

function AuthPillClock({ state, onLogin, onLogout }: AuthPillProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!state?.logged_in || !state.expires_at) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [state?.expires_at, state?.logged_in])

  if (!state) {
    return (
      <span className="text-[11px] text-zinc-400 px-2 py-0.5">登录态加载中…</span>
    )
  }
  if (!state.logged_in) {
    return (
      <Button size="sm" className="h-8 text-xs gap-1.5" onClick={onLogin}>
        <ScanLine className="w-3.5 h-3.5" />
        {state.expired ? '凭据过期，重新扫码' : '扫码登录公众平台'}
      </Button>
    )
  }
  const remaining = state.expires_at
    ? Math.max(0, Math.round((new Date(state.expires_at).getTime() - now) / 60000))
    : 0
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-50 dark:bg-green-950 border border-green-200/60 dark:border-green-900">
      <span className="text-[11px] text-green-700 dark:text-green-300">
        已登录{state.nickname ? ` · ${state.nickname}` : ''} · 剩余 {remaining}min
      </span>
      <button onClick={onLogout}
        className="text-green-600 hover:text-red-500 transition-colors"
        title="退出登录">
        <LogOut className="w-3 h-3" />
      </button>
    </div>
  )
}

// ── Article Card ───────────────────────────────────────────────────────────────

function ArticleCard({
  article, onOpen, onDelete,
}: {
  article: WechatArticle
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="group relative w-full text-left flex gap-4 py-4 px-3 -mx-3 rounded-xl border-b border-zinc-100 dark:border-zinc-900 last:border-0 hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40 transition-colors cursor-pointer"
    >
      <div className="flex-shrink-0 w-28 h-20 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800/60 ring-1 ring-zinc-200/60 dark:ring-zinc-800 flex items-center justify-center">
        {article.cover_url ? (
          <img
            src={wechatImg(article.cover_url)}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <MessageSquare className="w-6 h-6 text-zinc-300 dark:text-zinc-700" />
        )}
      </div>

      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 truncate leading-snug
                       group-hover:text-green-700 dark:group-hover:text-green-400 transition-colors">
          {article.title}
        </h3>

        <div className="flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 flex-wrap min-w-0">
          <span>{fmtFullDate(article.published_at)}</span>
          {article.account_name && (
            <>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-zinc-600 dark:text-zinc-300 font-medium truncate max-w-[160px] flex items-center gap-1">
                <MessageSquare className="w-3 h-3 text-green-500 flex-shrink-0" />
                {article.account_name}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2.5 text-[11px] text-zinc-400 dark:text-zinc-500" />
          <div className="ml-auto flex items-center gap-0.5">
            <AddToTopicPopover
              url={article.url}
              title={article.title}
              summary={article.digest ?? ''}
              platform="wechat"
            />
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title="删除"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Account filter (searchable dropdown) ────────────────────────────────────────

function AccountFilter({
  accounts, selected, onSelect,
}: {
  accounts: string[]
  selected: string | null
  onSelect: (a: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? accounts.filter(a => a.toLowerCase().includes(s)) : accounts
  }, [accounts, q])

  if (accounts.length === 0) return null

  function pick(a: string | null) {
    onSelect(a)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); if (o) setQ('') }}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors max-w-[180px]"
          />
        }
      >
        <MessageSquare className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
        <span className="truncate">{selected ?? '全部公众号'}</span>
        <ChevronDown className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0 ml-auto" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="搜索公众号…"
          className="h-8 text-xs mb-1.5"
        />
        <div className="max-h-64 overflow-y-auto">
          <button
            type="button"
            onClick={() => pick(null)}
            className={cn(
              'w-full flex items-center gap-2 text-left px-2 py-1.5 text-xs rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
              selected === null && 'text-green-600 dark:text-green-400 font-medium',
            )}
          >
            <Check className={cn('w-3.5 h-3.5 flex-shrink-0', selected === null ? 'opacity-100' : 'opacity-0')} />
            全部公众号
          </button>
          {filtered.map(a => (
            <button
              key={a}
              type="button"
              onClick={() => pick(a)}
              className={cn(
                'w-full flex items-center gap-2 text-left px-2 py-1.5 text-xs rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
                selected === a && 'text-green-600 dark:text-green-400 font-medium',
              )}
            >
              <Check className={cn('w-3.5 h-3.5 flex-shrink-0', selected === a ? 'opacity-100' : 'opacity-0')} />
              <span className="truncate">{a}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-zinc-400">无匹配公众号</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function WechatClient({ initialArticles }: { initialArticles: WechatArticle[] }) {
  const [articles, setArticles] = useState(initialArticles)
  const [search, setSearch] = useState('')
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [auth, setAuth] = useState<WechatAuthState | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [subsOpen, setSubsOpen] = useState(false)
  const [collect, setCollect] = useState<WechatCollectStatus | null>(null)
  const collectPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wasCollectingRef = useRef(false)
  const collecting = collect?.running ?? false

  // Reader state — side panel on wide screens, modal otherwise
  const useSidePanel = useMediaQuery('(min-width: 1280px)')
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerLoading, setReaderLoading] = useState(false)
  const [readerMeta, setReaderMeta] = useState<ReaderMeta | null>(null)

  async function openReader(article: WechatArticle) {
    setReaderOpen(true)
    setReaderMeta({
      title: article.title,
      author: article.account_name,
      source: '公众号',
      published_at: article.published_at,
      url: article.url,
      content: article.content || '',
    })
    if (!article.content) {
      setReaderLoading(true)
      try {
        const full = await getWechatArticle(article.id)
        setReaderMeta({
          title: full.title,
          author: full.account_name,
          source: '公众号',
          published_at: full.published_at,
          url: full.url,
          content: full.content || '',
        })
        setArticles(prev => prev.map(a => a.id === full.id ? full : a))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '正文加载失败')
      } finally {
        setReaderLoading(false)
      }
    }
  }

  const reloadAuth = useCallback(async () => {
    try {
      setAuth(await getWechatAuthState())
    } catch {
      setAuth({ logged_in: false, nickname: '', avatar: '', expires_at: null, expired: false })
    }
  }, [])

  const reloadArticles = useCallback(async () => {
    try {
      setArticles(await getWechatArticles({ limit: 1000 }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '刷新文章失败')
    }
  }, [])

  // ── One-click collect: kick off backend job, then poll its progress ──────────
  const stopCollectPoll = useCallback(() => {
    if (collectPollRef.current) {
      clearInterval(collectPollRef.current)
      collectPollRef.current = null
    }
  }, [])

  const pollCollect = useCallback(async () => {
    try {
      const st = await getWechatCollectStatus()
      setCollect(st)
      if (st.running) {
        wasCollectingRef.current = true
        return
      }
      stopCollectPoll()
      if (wasCollectingRef.current) {
        wasCollectingRef.current = false
        if (st.errors.length) toast.warning(st.message || `采集完成，${st.errors.length} 个失败`)
        else toast.success(st.message || '采集完成')
        reloadArticles()
      }
    } catch {
      // transient network blip — keep polling
    }
  }, [stopCollectPoll, reloadArticles])

  const startCollectPoll = useCallback(() => {
    stopCollectPoll()
    collectPollRef.current = setInterval(pollCollect, 1500)
  }, [stopCollectPoll, pollCollect])

  async function handleCollectAll() {
    if (!auth?.logged_in) {
      toast.info('请先扫码登录公众平台')
      setLoginOpen(true)
      return
    }
    try {
      const st = await startWechatCollectAll()
      setCollect(st)
      wasCollectingRef.current = true
      startCollectPoll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '启动采集失败')
    }
  }

  useEffect(() => {
    void getWechatAuthState()
      .then(setAuth)
      .catch(() => setAuth({
        logged_in: false,
        nickname: '',
        avatar: '',
        expires_at: null,
        expired: false,
      }))
  }, [])

  // Resume showing progress if a collect job is already running (page reopened / 2nd tab)
  useEffect(() => {
    let cancelled = false
    getWechatCollectStatus()
      .then(st => {
        if (cancelled) return
        setCollect(st)
        if (st.running) { wasCollectingRef.current = true; startCollectPoll() }
      })
      .catch(() => { /* backend may be down; ignore */ })
    return () => { cancelled = true; stopCollectPoll() }
  }, [startCollectPoll, stopCollectPoll])

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

  const { visibleCount, sentinelRef, hasMore, reset: resetScroll } = useInfiniteScroll({
    totalCount: filtered.length,
    pageSize: PAGE_SIZE,
  })
  const visible = filtered.slice(0, visibleCount)

  async function handleDelete(article: WechatArticle) {
    try {
      await deleteWechatArticle(article.id)
      setArticles(prev => prev.filter(a => a.id !== article.id))
      toast.success('已删除')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function handleLogout() {
    try {
      await logoutWechat()
      toast.success('已退出登录')
      reloadAuth()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '退出失败')
    }
  }

  function handleManageClick() {
    if (!auth?.logged_in) {
      toast.info('请先扫码登录公众平台')
      setLoginOpen(true)
      return
    }
    setSubsOpen(true)
  }

  return (
    <div className="flex h-full">
      <div className={cn(
        'flex flex-col',
        useSidePanel
          ? 'w-[460px] flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800'
          : 'flex-1 min-w-0',
      )}>
        {/* Toolbar */}
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3 flex-shrink-0">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-green-500" />
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">公众号文章</span>
              <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
                {filtered.length} 篇
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <AuthPill state={auth} onLogin={() => setLoginOpen(true)} onLogout={handleLogout} />
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
                onClick={handleManageClick}>
                <Settings className="w-3.5 h-3.5" />
                订阅管理
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
                onClick={handleCollectAll} disabled={collecting}>
                {collecting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    采集中 {collect?.done ?? 0}/{collect?.total ?? 0}
                  </>
                ) : (
                  <>
                    <DownloadCloud className="w-3.5 h-3.5" />
                    一键采集
                  </>
                )}
              </Button>
              <AccountFilter
                accounts={accounts}
                selected={selectedAccount}
                onSelect={a => { setSelectedAccount(a); resetScroll() }}
              />
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                <Input
                  value={search}
                  onChange={e => { setSearch(e.target.value); resetScroll() }}
                  placeholder="搜索标题/公众号"
                  className="h-8 text-xs pl-8 w-40"
                />
              </div>
            </div>
          </div>

          {collecting && collect && (
            <div className="mt-2.5">
              <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-500 mb-1">
                <span className="flex items-center gap-1.5 min-w-0">
                  <Loader2 className="w-3 h-3 animate-spin text-green-500 flex-shrink-0" />
                  <span className="truncate">
                    采集中 {collect.done}/{collect.total}
                    {collect.current && ` · 当前：${collect.current}`}
                  </span>
                </span>
                <span className="flex-shrink-0 text-green-600 dark:text-green-400">
                  已新增 {collect.new_articles} 篇
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-green-500 transition-all duration-500"
                  style={{ width: `${collect.total ? Math.round((collect.done / collect.total) * 100) : 0}%` }}
                />
              </div>
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
                  ? '订阅公众号后点「一键采集」开始'
                  : '没有符合条件的文章'}
              </p>
            </div>
          ) : (
            <>
              <div className={useSidePanel ? '' : 'max-w-3xl'}>
                {visible.map(art => (
                  <ArticleCard key={art.id} article={art}
                    onOpen={() => openReader(art)}
                    onDelete={() => handleDelete(art)} />
                ))}
              </div>
              <div ref={sentinelRef} className="py-4">
                {hasMore && <span className="text-xs text-zinc-400">加载中…</span>}
              </div>
            </>
          )}
        </div>
      </div>

      <ResponsiveArticleReader
        asPanel={useSidePanel}
        open={readerOpen}
        onClose={() => setReaderOpen(false)}
        meta={readerMeta}
        loading={readerLoading}
        accent="green"
        contentTheme="paper"
        emptyContentMessage="正文尚未采集成功"
        headerActions={readerMeta && (
          <PushToStudioPopover
            url={readerMeta.url}
            title={readerMeta.title}
            content={readerMeta.content}
            platform="wechat"
            label="推送到工作室"
          />
        )}
      />

      {loginOpen && (
        <LoginDialog open onOpenChange={setLoginOpen} onLoggedIn={reloadAuth} />
      )}
      <SubscriptionsDialog open={subsOpen} onOpenChange={setSubsOpen}
        onChanged={() => { reloadArticles() }} />
    </div>
  )
}
