'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Radar, Pencil, FileEdit, ImagePlus, Plus, RefreshCw,
  ListChecks, PlayCircle, AlertTriangle, CheckCircle2,
  Clock, CheckCheck, Sparkles, Bell, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { getStudioBoard, deleteTask, type BoardSnapshot, type AgentState, type TaskBrief } from '@/lib/api/studio'
import { cn } from '@/lib/utils'
import { TaskDrawer } from './TaskDrawer'

const POLL_INTERVAL_MS = 2000

/* ── role & accent ────────────────────────────────────────────────────── */

type Accent = AgentState['accent']

const ACCENT_DOT: Record<Accent, string> = {
  amber:   'bg-amber-500',
  indigo:  'bg-indigo-500',
  emerald: 'bg-emerald-500',
  violet:  'bg-violet-500',
  rose:    'bg-rose-500',
}
const ACCENT_TEXT: Record<Accent, string> = {
  amber:   'text-amber-700 dark:text-amber-400',
  indigo:  'text-indigo-700 dark:text-indigo-400',
  emerald: 'text-emerald-700 dark:text-emerald-400',
  violet:  'text-violet-700 dark:text-violet-400',
  rose:    'text-rose-700 dark:text-rose-400',
}
const ACCENT_SOFT: Record<Accent, string> = {
  amber:   'bg-amber-50 dark:bg-amber-950/40',
  indigo:  'bg-indigo-50 dark:bg-indigo-950/40',
  emerald: 'bg-emerald-50 dark:bg-emerald-950/40',
  violet:  'bg-violet-50 dark:bg-violet-950/40',
  rose:    'bg-rose-50 dark:bg-rose-950/40',
}

const ROLE_ICON: Record<AgentState['role'], React.ElementType> = {
  scout:       Radar,
  editor:      Pencil,
  writer:      FileEdit,
  illustrator: ImagePlus,
}
const ROLE_LABEL_EN: Record<AgentState['role'], string> = {
  scout:       'SCOUT',
  editor:      'EDITOR',
  writer:      'WRITER',
  illustrator: 'ILLUST',
}
const ROLE_SUBTITLE: Record<AgentState['role'], string> = {
  scout:       '信号巡探',
  editor:      '策划编辑',
  writer:      '撰稿',
  illustrator: '封面设计',
}

const AGENT_STATUS_LABEL: Record<AgentState['status'], string> = {
  idle:    '在线',
  waiting: '空闲',
  working: '工作中',
  blocked: '受阻',
}
const AGENT_STATUS_PILL: Record<AgentState['status'], string> = {
  idle:    'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
  waiting: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
  working: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400',
  blocked: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400',
}
const AGENT_STATUS_DOT: Record<AgentState['status'], string> = {
  idle:    'bg-emerald-500',
  waiting: 'bg-zinc-400',
  working: 'bg-blue-500 animate-pulse',
  blocked: 'bg-rose-500 animate-pulse',
}

/* ── kanban columns (collapsed from 6 → 4 like the reference) ─────────── */

interface ColumnDef {
  key: string
  label: string
  icon: React.ElementType
  dot: string
  text: string
  /** map raw Hermes status → this column key */
  statuses: string[]
}

const COLUMNS: ColumnDef[] = [
  { key: 'pending',  label: '待处理', icon: Clock,         dot: 'bg-amber-500',   text: 'text-amber-600',   statuses: ['triage', 'todo', 'ready'] },
  { key: 'running',  label: '进行中', icon: PlayCircle,    dot: 'bg-blue-500',    text: 'text-blue-600',    statuses: ['running'] },
  { key: 'blocked',  label: '受阻',   icon: AlertTriangle, dot: 'bg-rose-500',    text: 'text-rose-600',    statuses: ['blocked'] },
  { key: 'done',     label: '已完成', icon: CheckCircle2,  dot: 'bg-emerald-500', text: 'text-emerald-600', statuses: ['done'] },
]

const ASSIGNEE_ACCENT: Record<string, Accent> = {
  wms_scout:       'amber',
  wms_editor:      'indigo',
  wms_writer:      'emerald',
  wms_illustrator: 'violet',
}
const ASSIGNEE_ROLE: Record<string, AgentState['role']> = {
  wms_scout:       'scout',
  wms_editor:      'editor',
  wms_writer:      'writer',
  wms_illustrator: 'illustrator',
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function fmtElapsed(s: number | null | undefined): string {
  if (s === null || s === undefined || s < 0) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}m${sec.toString().padStart(2, '0')}s`
}

function fmtDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function fmtAgo(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60) return `${Math.max(1, diff)} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

/* ── tiny avatar ──────────────────────────────────────────────────────── */

function AgentAvatar({ assignee, size = 28 }: { assignee: string; size?: number }) {
  const accent = ASSIGNEE_ACCENT[assignee] ?? 'indigo'
  const role = ASSIGNEE_ROLE[assignee] ?? 'editor'
  const Icon = ROLE_ICON[role]
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-md text-white shrink-0', ACCENT_DOT[accent])}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  )
}

/* ── KPI card ─────────────────────────────────────────────────────────── */

function KpiCard({
  label, value, sub, icon: Icon, iconBg, iconColor,
}: {
  label: string
  value: number | string
  sub?: string
  icon: React.ElementType
  iconBg: string
  iconColor: string
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-5 py-4 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{label}</div>
          <div className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
            {value}
          </div>
          {sub && <div className="text-[11px] text-zinc-400 mt-0.5">{sub}</div>}
        </div>
        <div className={cn('w-10 h-10 rounded-full flex items-center justify-center shrink-0', iconBg)}>
          <Icon className={cn('w-5 h-5', iconColor)} />
        </div>
      </div>
    </div>
  )
}

/* ── task card (kanban) ───────────────────────────────────────────────── */

function TaskCard({ task, now, onOpen, onDelete }: { task: TaskBrief; now: number; onOpen: (id: string) => void; onDelete: (id: string, title: string) => void }) {
  const accent = ASSIGNEE_ACCENT[task.assignee] ?? 'indigo'
  const role = ASSIGNEE_ROLE[task.assignee] ?? 'editor'
  const ts = task.completed_at ?? task.started_at ?? task.created_at
  const isRunning = task.status === 'running' && task.started_at

  return (
    <div className="relative group">
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="text-left w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-sm transition cursor-pointer">
        {/* title */}
        <div className="text-[13px] font-medium leading-snug text-zinc-800 dark:text-zinc-200 line-clamp-2 mb-2 pr-5">
          {task.title}
        </div>
        {/* small tag */}
        <div className="mb-3">
          <span className={cn(
            'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
            ACCENT_SOFT[accent], ACCENT_TEXT[accent],
          )}>
            {ROLE_SUBTITLE[role]}
          </span>
        </div>
        {/* footer: avatar + name + date */}
        <div className="flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1.5 min-w-0">
            <AgentAvatar assignee={task.assignee} size={18} />
            <span className="text-zinc-600 dark:text-zinc-400 truncate">
              {ROLE_LABEL_EN[role]} Agent
            </span>
          </div>
          <span className={cn('shrink-0 ml-2 tabular-nums', isRunning ? 'text-blue-600 font-medium' : 'text-zinc-400')}>
            {isRunning ? `⏱ ${fmtElapsed(now - (task.started_at ?? 0))}` : fmtDate(ts)}
          </span>
        </div>
      </button>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onDelete(task.id, task.title) }}
        className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition"
        title="删除任务"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

/* ── kanban column ────────────────────────────────────────────────────── */

function KanbanColumn({ col, tasks, now, onOpen, onDelete }: { col: ColumnDef; tasks: TaskBrief[]; now: number; onOpen: (id: string) => void; onDelete: (id: string, title: string) => void }) {
  return (
    <div className="flex flex-col bg-zinc-50 dark:bg-zinc-900/50 rounded-xl">
      {/* header */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full', col.dot)} />
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{col.label}</span>
          <span className="text-[11px] text-zinc-400 tabular-nums">{tasks.length}</span>
        </div>
      </div>
      {/* cards */}
      <div className="px-2 pb-2 space-y-2 min-h-[200px] max-h-[calc(100vh-360px)] overflow-y-auto">
        {tasks.map(t => <TaskCard key={t.id} task={t} now={now} onOpen={onOpen} onDelete={onDelete} />)}
        {/* "+ 新建任务" stub */}
        <button
          onClick={() => toast.info('「发布任务」入口将放到公众号/X 面板的文章上 — 选好素材再入队')}
          className="w-full py-2 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-800 text-[11px] text-zinc-400 hover:text-zinc-600 hover:border-zinc-400 dark:hover:border-zinc-700 transition flex items-center justify-center gap-1"
        >
          <Plus className="w-3 h-3" />
          新建任务
        </button>
      </div>
    </div>
  )
}

/* ── team member row ──────────────────────────────────────────────────── */

function MemberRow({ agent }: { agent: AgentState }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <AgentAvatar assignee={agent.name} size={32} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200 truncate">
          {ROLE_LABEL_EN[agent.role]} Agent
        </div>
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
          {agent.display_name}
        </div>
      </div>
      <div className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0',
        AGENT_STATUS_PILL[agent.status],
      )}>
        <span className={cn('w-1.5 h-1.5 rounded-full', AGENT_STATUS_DOT[agent.status])} />
        {AGENT_STATUS_LABEL[agent.status]}
      </div>
    </div>
  )
}

/* ── activity row ─────────────────────────────────────────────────────── */

function ActivityRow({ task, now }: { task: TaskBrief; now: number }) {
  const role = ASSIGNEE_ROLE[task.assignee] ?? 'editor'
  const ts = task.completed_at ?? task.started_at ?? task.created_at

  let verb = '处理了'
  if (task.status === 'done') verb = '完成了'
  else if (task.status === 'running') verb = '正在处理'
  else if (task.status === 'blocked') verb = '阻塞在'
  else if (task.status === 'ready' || task.status === 'todo' || task.status === 'triage') verb = '排队'

  return (
    <div className="flex items-start gap-2.5 py-2">
      <AgentAvatar assignee={task.assignee} size={24} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] leading-snug text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">{ROLE_LABEL_EN[role]} Agent</span>
          <span className="text-zinc-500 dark:text-zinc-400"> {verb} </span>
          <span className="text-zinc-600 dark:text-zinc-400 truncate inline-block max-w-[200px] align-bottom">
            「{task.title}」
          </span>
        </div>
        <div className="text-[10px] text-zinc-400 mt-0.5">{fmtAgo(ts, now)}</div>
      </div>
    </div>
  )
}

/* ── main ─────────────────────────────────────────────────────────────── */

export function StudioClient() {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  async function handleDelete(id: string, title: string) {
    if (!window.confirm(`归档并删除任务？\n\n「${title}」\n\n此操作不可撤销。`)) return
    try {
      await deleteTask(id)
      toast.success('任务已归档删除')
      setSnapshot(prev => prev ? {
        ...prev,
        recent_tasks: prev.recent_tasks.filter(t => t.id !== id),
      } : prev)
    } catch (e) {
      toast.error('删除失败：' + (e instanceof Error ? e.message : '未知错误'))
    }
  }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll() {
      try {
        const data = await getStudioBoard()
        if (!cancelled) {
          setSnapshot(data)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setTick(t => (t + 1) % 1_000_000), 1000)
    return () => clearInterval(id)
  }, [])
  void tick

  const now = Math.floor(Date.now() / 1000)

  // group recent tasks by column key
  const grouped = useMemo(() => {
    const g: Record<string, TaskBrief[]> = {}
    for (const c of COLUMNS) g[c.key] = []
    if (!snapshot) return g
    for (const t of snapshot.recent_tasks) {
      const col = COLUMNS.find(c => c.statuses.includes(t.status))
      if (col) g[col.key].push(t)
    }
    return g
  }, [snapshot])

  const agentsLive = useMemo(() => {
    if (!snapshot) return []
    return snapshot.agents.map(a => {
      if (a.status === 'working' && a.current_task?.started_at) {
        return { ...a, elapsed_seconds: now - a.current_task.started_at }
      }
      return a
    })
  }, [snapshot, now])

  // recent done tasks for activity feed
  const activity = useMemo(() => {
    if (!snapshot) return []
    return [...snapshot.recent_tasks]
      .filter(t => t.completed_at)
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
      .slice(0, 8)
  }, [snapshot])

  // KPI values
  const counts = snapshot?.counts ?? {}
  const total = (snapshot?.recent_tasks.length ?? 0) // shown is the recent 25; for total we use counts
  const totalAll = Object.entries(counts)
    .filter(([k]) => k !== 'archived')
    .reduce((sum, [, v]) => sum + (v as number), 0)
  const doneAll = counts.done ?? 0
  const runningAll = counts.running ?? 0
  const pendingAll = (counts.triage ?? 0) + (counts.todo ?? 0) + (counts.ready ?? 0)
  const blockedAll = counts.blocked ?? 0
  const completedToday = agentsLive.reduce((s, a) => s + a.completed_today, 0)

  void total

  if (error && !snapshot) {
    return (
      <div className="px-8 py-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">工作室</h1>
        <p className="mt-4 text-sm text-rose-600">
          无法连接 Hermes 看板：{error}<br />
          检查 backend uvicorn 是否运行，<code>/api/studio/board</code> 是否可用。
        </p>
      </div>
    )
  }
  if (!snapshot) {
    return (
      <div className="px-8 py-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">工作室</h1>
        <p className="mt-4 text-sm text-zinc-500">加载中…</p>
      </div>
    )
  }

  const isRunning = runningAll > 0

  return (
    <div className="px-6 py-5 space-y-5">
      {/* ── header ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">工作室看板</h1>
            <span className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium',
              isRunning
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
            )}>
              <span className={cn('w-1.5 h-1.5 rounded-full', isRunning ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500')} />
              {isRunning ? `${runningAll} 个进行中` : '全部空闲'}
            </span>
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            4 个 agent 在 Hermes Kanban <code className="text-[11px] px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900">test</code> 板上的实时分工，每 2 秒刷新
          </p>
        </div>
        <button
          onClick={() => toast.info('「发布任务」入口接下来放到公众号/X 面板，从素材直接入队 →')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium shadow-sm transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          发布任务
        </button>
      </div>

      {/* ── KPI cards ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="任务总数" value={totalAll} sub="历史累计" icon={ListChecks}
                 iconBg="bg-indigo-100 dark:bg-indigo-950/40" iconColor="text-indigo-600 dark:text-indigo-400" />
        <KpiCard label="已完成" value={doneAll} sub={`今日 ${completedToday}`} icon={CheckCheck}
                 iconBg="bg-emerald-100 dark:bg-emerald-950/40" iconColor="text-emerald-600 dark:text-emerald-400" />
        <KpiCard label="进行中" value={runningAll} sub={runningAll > 0 ? '正在执行' : '当前无任务'} icon={PlayCircle}
                 iconBg="bg-blue-100 dark:bg-blue-950/40" iconColor="text-blue-600 dark:text-blue-400" />
        <KpiCard label="待处理" value={pendingAll} sub="排队 + 待派" icon={Clock}
                 iconBg="bg-amber-100 dark:bg-amber-950/40" iconColor="text-amber-600 dark:text-amber-400" />
        <KpiCard label="受阻" value={blockedAll} sub={blockedAll > 0 ? '需人工解锁' : '无阻塞'} icon={AlertTriangle}
                 iconBg="bg-rose-100 dark:bg-rose-950/40" iconColor="text-rose-600 dark:text-rose-400" />
      </div>

      {/* ── main grid: kanban + right panels ───────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* kanban */}
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">任务看板</h2>
            <span className="text-[11px] text-zinc-400 inline-flex items-center gap-1">
              <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: '4s' }} />
              {new Date(snapshot.server_time * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {COLUMNS.map(col => (
              <KanbanColumn key={col.key} col={col} tasks={grouped[col.key] ?? []} now={now} onOpen={setOpenTaskId} onDelete={handleDelete} />
            ))}
          </div>
        </section>

        {/* right side stack */}
        <aside className="space-y-4">
          {/* team members */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">团队成员</h2>
              <span className="text-[11px] text-zinc-400">{agentsLive.length} 位</span>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {agentsLive.map(a => (
                <MemberRow key={a.name} agent={a} />
              ))}
            </div>
          </section>

          {/* activity feed */}
          <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 inline-flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                最新动态
              </h2>
              <span className="text-[11px] text-zinc-400">{activity.length} 条</span>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {activity.length === 0 ? (
                <p className="text-xs text-zinc-400 italic py-4 text-center">还没有动态</p>
              ) : (
                activity.map(t => <ActivityRow key={t.id} task={t} now={now} />)
              )}
            </div>
          </section>
        </aside>
      </div>

      {error && (
        <p className="text-[11px] text-amber-600">
          ⚠ 最新轮询失败：{error}（继续使用上一次成功的数据）
        </p>
      )}

      <TaskDrawer
        taskId={openTaskId}
        open={openTaskId !== null}
        onClose={() => setOpenTaskId(null)}
        onOpenTask={(id) => setOpenTaskId(id)}
        onDeleted={(id) => {
          setOpenTaskId(null)
          setSnapshot(prev => prev ? {
            ...prev,
            recent_tasks: prev.recent_tasks.filter(t => t.id !== id),
          } : prev)
        }}
      />
    </div>
  )
}
