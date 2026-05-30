'use client'

import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  X, Copy, ExternalLink, Folder, GitBranch, Radar, Pencil, FileEdit,
  Clock, PlayCircle, CheckCircle2, AlertTriangle, ChevronRight, Unlock, Loader2, CheckSquare, Trash2,
  Terminal, Coins, MessageSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getStudioTaskDetail, unblockStudioTask, completeStudioTask, deleteTask, getTaskLog, getTaskUsage,
  type TaskDetail, type TaskComment, type TaskUsage,
} from '@/lib/api/studio'
import { cn } from '@/lib/utils'
import { RetroTerminalDialog } from '@/components/features/RetroTerminalDialog'

/* ── role & status mapping (mirror StudioClient) ──────────────────────── */

const ASSIGNEE_META: Record<string, { icon: React.ElementType; label: string; sub: string; bg: string; text: string; soft: string }> = {
  wms_scout:  { icon: Radar,      label: 'SCOUT',  sub: '信号探子', bg: 'bg-amber-500',   text: 'text-amber-700 dark:text-amber-400',   soft: 'bg-amber-50 dark:bg-amber-950/40' },
  wms_editor: { icon: Pencil,     label: 'EDITOR', sub: '策划编辑', bg: 'bg-indigo-500',  text: 'text-indigo-700 dark:text-indigo-400', soft: 'bg-indigo-50 dark:bg-indigo-950/40' },
  wms_writer: { icon: FileEdit,   label: 'WRITER', sub: '撰稿',     bg: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', soft: 'bg-emerald-50 dark:bg-emerald-950/40' },
}

// 复盘对话用的 agent 显示名（覆盖全部 6 个 profile；ASSIGNEE_META 只有 3 个）
const RETRO_LABEL: Record<string, string> = {
  wms_scout: '信号探子', wms_editor: '策划编辑', wms_writer: '撰稿人',
  wms_short_writer: '短稿撰稿', wms_illustrator: '封面设计师', wms_critic: '终审编辑',
}

const STATUS_META: Record<string, { label: string; chip: string; icon: React.ElementType }> = {
  triage:   { label: '初筛',   chip: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300', icon: Clock },
  todo:     { label: '排队',   chip: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',           icon: Clock },
  ready:    { label: '待派',   chip: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',     icon: Clock },
  running:  { label: '进行中', chip: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',         icon: PlayCircle },
  blocked:  { label: '受阻',   chip: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',         icon: AlertTriangle },
  review:   { label: '评审中', chip: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300',         icon: AlertTriangle },
  done:     { label: '已完成', chip: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300', icon: CheckCircle2 },
  archived: { label: '已归档', chip: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',           icon: Clock },
}

const EVENT_LABEL: Record<string, string> = {
  created:           '创建',
  promoted:          '晋升',
  claimed:           '认领',
  spawned:           '派出 worker',
  heartbeat:         '心跳',
  completed:         '完成',
  blocked:           '受阻',
  unblocked:         '解锁',
  archived:          '归档',
  assigned:          '改派',
  edited:            '编辑',
  reprioritized:     '调优先级',
  status:            '状态',
  commented:         '留言',
  reclaimed:         '重新认领',
  crashed:           '崩溃',
  timed_out:         '超时',
  protocol_violation: '协议违规',
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function fmtFull(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtElapsed(s: number | null | undefined): string {
  if (s === null || s === undefined || s < 0) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}m${sec.toString().padStart(2, '0')}s`
}

function copyText(s: string, label = '已复制') {
  navigator.clipboard.writeText(s).then(
    () => toast.success(label),
    () => toast.error('复制失败'),
  )
}

function renderMarkdown(md: string): string {
  // marked v18 returns string sync when async: false (default)
  return marked.parse(md, { async: false, breaks: true }) as string
}

/* ── main drawer ──────────────────────────────────────────────────────── */

export function TaskDrawer({
  taskId,
  open,
  onClose,
  onOpenTask,
  onDeleted,
}: {
  taskId: string | null
  open: boolean
  onClose: () => void
  onOpenTask?: (id: string) => void
  onDeleted?: (id: string) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<null | 'unblock' | 'complete' | 'delete'>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [retroOpen, setRetroOpen] = useState(false)

  async function handleUnblock() {
    if (!taskId) return
    const note = window.prompt('解锁前留一句备注（可空，留空则只解锁不评论）', '')
    if (note === null) return
    setActionBusy('unblock')
    try {
      await unblockStudioTask(taskId, note)
      toast.success('已解锁，任务回到 ready')
      const d = await getStudioTaskDetail(taskId)
      setDetail(d)
    } catch (e) {
      toast.error('解锁失败：' + (e instanceof Error ? e.message : '未知错误'))
    } finally {
      setActionBusy(null)
    }
  }

  async function handleDelete() {
    if (!taskId) return
    const title = detail?.task.title ?? taskId
    if (!window.confirm(`归档并删除任务？\n\n「${title}」\n\n此操作不可撤销。`)) return
    setActionBusy('delete')
    try {
      await deleteTask(taskId)
      toast.success('任务已归档删除')
      onDeleted?.(taskId)
      onClose()
    } catch (e) {
      toast.error('删除失败：' + (e instanceof Error ? e.message : '未知错误'))
    } finally {
      setActionBusy(null)
    }
  }

  async function handleComplete() {
    if (!taskId) return
    if (!window.confirm('直接结束任务？\n任务标记为 done，不会再触发下游 agent。\n（如果想让 writer 重写请用「解锁重跑」）')) return
    const note = window.prompt('留一句结束理由（可空）', '')
    if (note === null) return
    setActionBusy('complete')
    try {
      await completeStudioTask(taskId, note)
      toast.success('任务已结束')
      const d = await getStudioTaskDetail(taskId)
      setDetail(d)
    } catch (e) {
      toast.error('结束失败：' + (e instanceof Error ? e.message : '未知错误'))
    } finally {
      setActionBusy(null)
    }
  }

  // fetch on open
  useEffect(() => {
    if (!open || !taskId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setDetail(null)
    getStudioTaskDetail(taskId)
      .then(d => { if (!cancelled) { setDetail(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [taskId, open])

  // scroll to top on new task
  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = 0
  }, [taskId, open])

  // ESC to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const assignee = detail?.task.assignee ?? ''
  const retroLabel = RETRO_LABEL[assignee] ?? assignee
  const canRetro = !!detail && !!assignee && (
    (detail.runs?.length ?? 0) > 0 ||
    ['running', 'review', 'blocked', 'done', 'archived'].includes(detail.task.status)
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={onClose}
      />
      {/* modal */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-3xl max-h-[85vh] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        {/* header */}
        <header className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">任务详情</h2>
            {taskId && (
              <code className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900">
                {taskId}
              </code>
            )}
            {taskId && (
              <button
                onClick={() => copyText(taskId, '已复制任务 ID')}
                className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900 text-zinc-400 hover:text-zinc-600"
                title="复制 ID"
              >
                <Copy className="w-3 h-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            {detail?.task.status === 'blocked' && (
              <>
                <button
                  onClick={handleUnblock}
                  disabled={actionBusy !== null}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70 disabled:opacity-50"
                  title="解锁任务，回到 ready 等 dispatcher 重派"
                >
                  {actionBusy === 'unblock' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlock className="w-3.5 h-3.5" />}
                  解锁重跑
                </button>
                <button
                  onClick={handleComplete}
                  disabled={actionBusy !== null}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50"
                  title="直接结束任务，不再触发下游"
                >
                  {actionBusy === 'complete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckSquare className="w-3.5 h-3.5" />}
                  结束任务
                </button>
              </>
            )}
            {canRetro && (
              <button
                onClick={() => setRetroOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-950/70"
                title="恢复该 agent 执行此任务的会话，跟它复盘这次做得怎么样"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                复盘
              </button>
            )}
            {detail && (
              <button
                onClick={handleDelete}
                disabled={actionBusy !== null}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50 transition"
                title="归档删除任务"
              >
                {actionBusy === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              title="关闭 (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {taskId && (
          <RetroTerminalDialog
            open={retroOpen}
            onClose={() => setRetroOpen(false)}
            taskId={taskId}
            profile={assignee}
            agentLabel={retroLabel}
          />
        )}

        {/* body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {loading && (
            <p className="p-8 text-sm text-zinc-500 text-center">加载中…</p>
          )}
          {error && (
            <p className="p-8 text-sm text-rose-600 text-center">
              无法加载：{error}
            </p>
          )}
          {detail && <DetailBody detail={detail} taskId={taskId!} onOpenTask={onOpenTask} />}
        </div>
      </div>
    </div>
  )
}

/* ── body content ─────────────────────────────────────────────────────── */

function extractFlow(body: string | null | undefined): string | null {
  if (!body) return null
  const m = body.match(/^flow:\s*(\S+)/m)
  return m ? m[1] : null
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toString()
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(3)
}

function DetailBody({ detail, taskId, onOpenTask }: { detail: TaskDetail; taskId: string; onOpenTask?: (id: string) => void }) {
  const t = detail.task
  const meta = ASSIGNEE_META[t.assignee] ?? ASSIGNEE_META.wms_editor
  const RoleIcon = meta.icon
  const statusMeta = STATUS_META[t.status] ?? STATUS_META.triage
  const StatusIcon = statusMeta.icon

  const elapsed = t.completed_at && t.started_at ? t.completed_at - t.started_at : null

  return (
    <div className="px-5 py-4 space-y-6">
      {/* title block */}
      <section>
        <div className="flex items-start gap-3 mb-2">
          <span className={cn('w-10 h-10 rounded-lg flex items-center justify-center text-white shrink-0', meta.bg)}>
            <RoleIcon className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 leading-snug">
              {t.title}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium', meta.soft, meta.text)}>
                <span className="font-mono tracking-wider">{meta.label}</span>
                <span className="text-zinc-400 dark:text-zinc-600">·</span>
                <span>{meta.sub}</span>
              </span>
              <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium', statusMeta.chip)}>
                <StatusIcon className="w-2.5 h-2.5" />
                {statusMeta.label}
              </span>
              {(() => {
                const flow = extractFlow(t.body)
                if (!flow) return null
                const isCover = flow === 'cover_only'
                return (
                  <span className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium',
                    isCover
                      ? 'bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300'
                      : 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
                  )}>
                    {isCover ? '仅重绘封面' : '完整流程'}
                  </span>
                )
              })()}
            </div>
          </div>
        </div>

        {/* latest summary (LLM's last words) */}
        {detail.latest_summary && (
          <div className="mt-3 px-3 py-2 rounded-md bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
            <div className="text-[10px] font-medium text-zinc-400 mb-1 uppercase tracking-wider">最近一句话总结</div>
            <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">{detail.latest_summary}</p>
          </div>
        )}
      </section>

      {/* metadata grid */}
      <section className="grid grid-cols-2 gap-3 text-xs">
        <MetaItem label="创建时间" value={fmtFull(t.created_at)} />
        <MetaItem label="开始时间" value={fmtFull(t.started_at)} />
        <MetaItem label="完成时间" value={fmtFull(t.completed_at)} />
        <MetaItem
          label="耗时"
          value={elapsed !== null ? fmtElapsed(elapsed) : '—'}
          accent={elapsed !== null ? 'text-emerald-600 dark:text-emerald-400 font-medium font-mono' : undefined}
        />
        <MetaItem label="创建者" value={t.created_by ?? '—'} />
        <MetaItem label="优先级" value={t.priority?.toString() ?? '0'} />
        {t.tenant && <MetaItem label="租户" value={t.tenant} />}
        {t.workspace_kind && (
          <MetaItem
            label="工作区"
            value={
              <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                <Folder className="w-3 h-3" />
                {t.workspace_kind}
              </span>
            }
          />
        )}
        {t.branch_name && (
          <MetaItem
            label="分支"
            value={
              <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                <GitBranch className="w-3 h-3" />
                {t.branch_name}
              </span>
            }
          />
        )}
        {(t.skills?.length ?? 0) > 0 && (
          <MetaItem
            label="技能"
            value={t.skills!.map(s => (
              <code key={s} className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 text-[10px] mr-1">
                {s}
              </code>
            ))}
          />
        )}
      </section>

      {/* parents / children */}
      {(detail.parents.length > 0 || detail.children.length > 0) && (
        <section>
          <SectionHeader title="链路依赖" />
          <div className="space-y-2 text-xs">
            {detail.parents.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-zinc-500 mr-1">← 父任务:</span>
                {detail.parents.map(p => (
                  <TaskLink key={p} id={p} onOpenTask={onOpenTask} />
                ))}
              </div>
            )}
            {detail.children.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-zinc-500 mr-1">→ 子任务:</span>
                {detail.children.map(c => (
                  <TaskLink key={c} id={c} onOpenTask={onOpenTask} />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* body */}
      {t.body && (
        <section>
          <SectionHeader title="任务正文（原始素材）" copyable={t.body} />
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 p-3">
            <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300 font-sans">
              {t.body}
            </pre>
          </div>
        </section>
      )}

      {/* comments (where the brief / score lives) */}
      {detail.comments.length > 0 && (
        <section>
          <SectionHeader title={`Agent 留言 (${detail.comments.length})`} />
          <div className="space-y-3">
            {detail.comments.map((c, i) => (
              <CommentCard key={i} comment={c} />
            ))}
          </div>
        </section>
      )}

      {/* runs */}
      {detail.runs.length > 0 && (
        <section>
          <SectionHeader title={`运行记录 (${detail.runs.length})`} />
          <div className="space-y-1.5">
            {detail.runs.map((r, i) => (
              <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-zinc-200 dark:border-zinc-800 text-[11px]">
                <span className="font-mono text-zinc-400 w-8">#{r.run_id ?? '?'}</span>
                <span className={cn(
                  'px-1.5 py-0.5 rounded font-medium',
                  r.outcome === 'completed'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : r.outcome === 'blocked'
                      ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
                )}>
                  {r.outcome ?? '—'}
                </span>
                <span className="text-zinc-500 font-mono w-16">
                  {r.elapsed_seconds !== null && r.elapsed_seconds !== undefined ? fmtElapsed(r.elapsed_seconds) : '—'}
                </span>
                <span className="text-zinc-400 text-[10px]">{fmtFull(r.started_at)}</span>
                {r.summary && (
                  <span className="text-zinc-700 dark:text-zinc-300 ml-auto truncate flex-1 text-right" title={r.summary}>
                    {r.summary}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* token usage */}
      <UsageSection taskId={taskId} hasRuns={detail.runs.length > 0} />

      {/* worker log (lazy) */}
      <LogSection taskId={taskId} hasRuns={detail.runs.length > 0} />

      {/* events timeline */}
      {detail.events.length > 0 && (
        <section>
          <SectionHeader title={`事件时间线 (${detail.events.length})`} />
          <ol className="space-y-1.5">
            {[...detail.events].reverse().map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px]">
                <span className="text-zinc-400 font-mono w-24 shrink-0">{fmtFull(e.created_at).slice(6)}</span>
                <span className={cn(
                  'px-1.5 py-0.5 rounded font-medium shrink-0',
                  e.kind === 'completed' || e.kind === 'promoted'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : e.kind === 'blocked' || e.kind === 'crashed' || e.kind === 'timed_out'
                      ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                      : e.kind === 'spawned' || e.kind === 'claimed' || e.kind === 'heartbeat'
                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
                )}>
                  {EVENT_LABEL[e.kind] ?? e.kind}
                </span>
                {e.run_id !== null && e.run_id !== undefined && (
                  <span className="text-zinc-400 font-mono shrink-0">#{e.run_id}</span>
                )}
                {e.payload && Object.keys(e.payload).length > 0 && (
                  <code className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate" title={JSON.stringify(e.payload)}>
                    {Object.entries(e.payload).slice(0, 3).map(([k, v]) => {
                      const s = typeof v === 'string' ? v : JSON.stringify(v)
                      return `${k}=${s.length > 30 ? s.slice(0, 30) + '…' : s}`
                    }).join(' · ')}
                  </code>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="h-4" />
    </div>
  )
}

/* ── small parts ──────────────────────────────────────────────────────── */

function SectionHeader({ title, copyable }: { title: string; copyable?: string }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {title}
      </h3>
      {copyable && (
        <button
          onClick={() => copyText(copyable, '已复制内容')}
          className="text-[10px] text-zinc-400 hover:text-zinc-600 inline-flex items-center gap-1"
          title="复制全文"
        >
          <Copy className="w-3 h-3" />
          复制
        </button>
      )}
    </div>
  )
}

function MetaItem({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-0.5">{label}</div>
      <div className={cn('text-zinc-700 dark:text-zinc-300 truncate', accent)}>{value}</div>
    </div>
  )
}

function TaskLink({ id, onOpenTask }: { id: string; onOpenTask?: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpenTask?.(id)}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 font-mono text-[11px] transition"
    >
      {id}
      <ChevronRight className="w-3 h-3" />
    </button>
  )
}

function CommentCard({ comment }: { comment: TaskComment }) {
  const meta = ASSIGNEE_META[comment.author]
  const isAgent = !!meta
  const Icon = meta?.icon ?? Pencil

  // body might be markdown (brief / score) — render it
  // but if author is 'default' it's usually a system block message; render plain
  const looksLikeMd = comment.body.includes('##') || comment.body.includes('**') || comment.body.includes('- ')
  const html = looksLikeMd ? renderMarkdown(comment.body) : null

  return (
    <article className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <header className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {isAgent ? (
            <span className={cn('w-5 h-5 rounded flex items-center justify-center text-white', meta.bg)}>
              <Icon className="w-3 h-3" />
            </span>
          ) : (
            <span className="w-5 h-5 rounded bg-zinc-300 dark:bg-zinc-700 flex items-center justify-center text-white">
              <span className="text-[9px]">SYS</span>
            </span>
          )}
          <span className={cn('text-xs font-medium truncate', meta?.text ?? 'text-zinc-700 dark:text-zinc-300')}>
            {isAgent ? `${meta!.label}  · ${meta!.sub}` : comment.author}
          </span>
          <span className="text-[10px] text-zinc-400 shrink-0">{fmtFull(comment.created_at)}</span>
        </div>
        <button
          onClick={() => copyText(comment.body, '已复制留言')}
          className="text-zinc-400 hover:text-zinc-600 shrink-0 p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900"
          title="复制留言"
        >
          <Copy className="w-3 h-3" />
        </button>
      </header>
      <div className="px-3 py-2.5">
        {html ? (
          <div
            className="prose prose-sm prose-zinc dark:prose-invert max-w-none text-[12px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-sm [&_h1]:mt-3 [&_h2]:text-[13px] [&_h2]:mt-3 [&_h3]:text-xs [&_pre]:text-[11px] [&_code]:text-[11px]"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300 font-sans">
            {comment.body}
          </pre>
        )}
      </div>
    </article>
  )
}

/* ── usage section (auto-load on mount) ───────────────────────────────── */

function UsageSection({ taskId, hasRuns }: { taskId: string; hasRuns: boolean }) {
  const [usage, setUsage] = useState<TaskUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!hasRuns) return
    let cancelled = false
    setLoading(true)
    setErr(null)
    setUsage(null)
    getTaskUsage(taskId)
      .then(u => { if (!cancelled) { setUsage(u); setLoading(false) } })
      .catch(e => { if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [taskId, hasRuns])

  if (!hasRuns) return null

  return (
    <section>
      <SectionHeader title="Token 消耗" />
      {loading && <p className="text-[11px] text-zinc-400">加载中…</p>}
      {err && <p className="text-[11px] text-rose-500">无法加载：{err}</p>}
      {usage && (
        <div className="space-y-2">
          {/* totals */}
          <div className="grid grid-cols-4 gap-2 text-xs">
            <UsageStat label="输入" value={fmtTokens(usage.total_input)} accent="text-blue-600 dark:text-blue-400" />
            <UsageStat label="输出" value={fmtTokens(usage.total_output)} accent="text-emerald-600 dark:text-emerald-400" />
            <UsageStat label="缓存读" value={fmtTokens(usage.total_cache_read)} accent="text-zinc-500" />
            <UsageStat label="花费" value={fmtUsd(usage.total_cost_usd)} accent="text-amber-600 dark:text-amber-400 font-mono" />
          </div>
          {/* per-run breakdown */}
          {usage.runs.length > 1 && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 select-none">
                分 run 明细（{usage.runs.length}）
              </summary>
              <div className="mt-1.5 space-y-1">
                {usage.runs.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-800 font-mono text-[10px]">
                    <span className="text-zinc-400 w-8">#{r.run_id ?? '?'}</span>
                    <span className="text-zinc-500 truncate w-20">{r.profile ?? '—'}</span>
                    <span className="text-blue-500">in {fmtTokens(r.input_tokens)}</span>
                    <span className="text-emerald-500">out {fmtTokens(r.output_tokens)}</span>
                    {r.cache_read_tokens > 0 && <span className="text-zinc-400">cache {fmtTokens(r.cache_read_tokens)}</span>}
                    <span className="text-amber-600 dark:text-amber-400 ml-auto">
                      {fmtUsd(r.actual_cost_usd ?? r.estimated_cost_usd ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  )
}

function UsageStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 px-2 py-1.5 bg-zinc-50/40 dark:bg-zinc-900/30">
      <div className="text-[9px] uppercase tracking-wider text-zinc-400 mb-0.5">{label}</div>
      <div className={cn('text-sm font-medium tabular-nums', accent)}>{value}</div>
    </div>
  )
}

/* ── log section (lazy, click to load) ────────────────────────────────── */

function LogSection({ taskId, hasRuns }: { taskId: string; hasRuns: boolean }) {
  const [log, setLog] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const r = await getTaskLog(taskId)
      setLog(r.log)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!hasRuns) return null

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          运行日志
        </h3>
        <div className="flex items-center gap-2">
          {log !== null && (
            <button
              onClick={() => copyText(log, '已复制日志')}
              className="text-[10px] text-zinc-400 hover:text-zinc-600 inline-flex items-center gap-1"
            >
              <Copy className="w-3 h-3" /> 复制
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="text-[10px] text-zinc-500 hover:text-indigo-600 inline-flex items-center gap-1 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Terminal className="w-3 h-3" />}
            {log !== null ? '刷新' : '加载日志'}
          </button>
        </div>
      </div>
      {err && <p className="text-[11px] text-rose-500">{err}</p>}
      {log !== null && (
        <pre className="max-h-80 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-950 text-zinc-200 px-3 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">
          {log || '(empty)'}
        </pre>
      )}
    </section>
  )
}

/* avoid unused-import warning when ExternalLink/Coins only used in future */
void ExternalLink
void Coins
