"use client"

import { useEffect, useRef, useState } from "react"
import { Radar, Pencil, FileEdit, ImagePlus, Loader2, RefreshCw, ExternalLink, MessageSquare, Activity, ScrollText, Trash2, Coins, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { getDraftTasks, getStudioTaskDetail, getTaskLog, getTaskUsage, deleteTask, rewriteDraft, DraftTaskBrief, TaskDetail, TaskUsage } from "@/lib/api/studio"

interface Props {
  open: boolean
  onClose: () => void
  draftId: number
  draftTitle: string
}

const ROLE_META: Record<string, { icon: React.ElementType; label: string; accent: string }> = {
  wms_scout:       { icon: Radar,     label: "信号探子",   accent: "amber" },
  wms_editor:      { icon: Pencil,    label: "策划编辑",   accent: "indigo" },
  wms_writer:      { icon: FileEdit,  label: "撰稿人",     accent: "emerald" },
  wms_illustrator: { icon: ImagePlus, label: "封面设计师", accent: "violet" },
}

const ACCENT_BG: Record<string, string> = {
  amber:   "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900",
  indigo:  "bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-900",
  emerald: "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900",
  violet:  "bg-violet-50 dark:bg-violet-950/40 border-violet-200 dark:border-violet-900",
  rose:    "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900",
}
const ACCENT_RING: Record<string, string> = {
  amber:   "ring-amber-400",
  indigo:  "ring-indigo-400",
  emerald: "ring-emerald-400",
  violet:  "ring-violet-400",
  rose:    "ring-rose-400",
}
const ACCENT_DOT: Record<string, string> = {
  amber:   "bg-amber-500",
  indigo:  "bg-indigo-500",
  emerald: "bg-emerald-500",
  violet:  "bg-violet-500",
  rose:    "bg-rose-500",
}

const STATUS_LABEL: Record<string, string> = {
  triage: "待整理", todo: "待办", ready: "队列中",
  running: "进行中", blocked: "受阻", done: "已完成",
  review: "评审中", archived: "已归档", scheduled: "已排程",
}

const EVENT_LABEL: Record<string, string> = {
  created:   "创建",
  promoted:  "晋升",
  claimed:   "认领",
  started:   "开始",
  completed: "完成",
  blocked:   "受阻",
  unblocked: "解锁",
  failed:    "失败",
  commented: "留言",
  updated:   "更新",
  archived:  "归档",
}

function fmtDt(ts: number | null): string {
  if (!ts) return "—"
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
}

function fmtDtSec(ts: number | null | undefined): string {
  if (!ts) return "—"
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return n.toString()
}

function fmtUsd(n: number): string {
  if (!n) return "$0"
  if (n < 0.01) return "$" + n.toFixed(4)
  return "$" + n.toFixed(3)
}

function UsageStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 px-1.5 py-1 bg-zinc-50/50 dark:bg-zinc-900/40">
      <div className="text-[9px] uppercase tracking-wider text-zinc-400 mb-0.5">{label}</div>
      <div className={cn("text-xs font-medium tabular-nums", accent)}>{value}</div>
    </div>
  )
}

function fmtElapsed(start: number | null, end: number | null): string {
  if (!start) return ""
  const e = end || Math.floor(Date.now() / 1000)
  const s = e - start
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`
}

type RightTab = "detail" | "log"

export function DraftTaskTimelineDialog({ open, onClose, draftId, draftTitle }: Props) {
  const [tasks, setTasks] = useState<DraftTaskBrief[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [rightTab, setRightTab] = useState<RightTab>("detail")
  const [log, setLog] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logForTaskId, setLogForTaskId] = useState<string | null>(null)
  const [usage, setUsage] = useState<TaskUsage | null>(null)
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [rewriteNote, setRewriteNote] = useState("")
  const [rewriteBusy, setRewriteBusy] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  async function handleRewrite() {
    setRewriteBusy(true)
    try {
      const res = await rewriteDraft({ draft_id: draftId, note: rewriteNote })
      toast.success(`已派 writer 重写 · ${res.task_id}`)
      setRewriteOpen(false)
      setRewriteNote("")
      setTimeout(refresh, 800)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "派单失败")
    } finally {
      setRewriteBusy(false)
    }
  }

  async function refresh() {
    setLoading(true)
    try {
      const data = await getDraftTasks(draftId)
      setTasks(data.tasks)
      if (!selectedId && data.tasks.length > 0) {
        setSelectedId(data.tasks[data.tasks.length - 1].id)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  async function loadDetail(taskId: string) {
    setDetailLoading(true)
    try {
      const d = await getStudioTaskDetail(taskId)
      setDetail(d)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载详情失败")
    } finally {
      setDetailLoading(false)
    }
  }

  async function loadUsage(taskId: string) {
    try {
      const u = await getTaskUsage(taskId)
      // ignore if user already switched task
      setUsage(prev => (prev && prev.task_id !== taskId ? prev : u))
    } catch {
      setUsage(null)
    }
  }

  async function handleDelete(taskId: string, title: string) {
    if (!confirm(`归档删除「${title}」？`)) return
    try {
      await deleteTask(taskId)
      toast.success("已归档")
      if (selectedId === taskId) { setSelectedId(null); setDetail(null) }
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败")
    }
  }

  async function loadLog(taskId: string) {
    setLogLoading(true)
    setLog(null)
    setLogForTaskId(taskId)
    try {
      const res = await getTaskLog(taskId)
      // discard if user switched tasks while we were fetching
      setLog(prev => {
        if (taskId !== logForTaskIdRef.current) return prev
        return res.log
      })
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      })
    } catch (e) {
      setLog(e instanceof Error ? e.message : "日志加载失败")
    } finally {
      setLogLoading(false)
    }
  }

  // mirror logForTaskId into a ref so the async loadLog callback can read it.
  const logForTaskIdRef = useRef<string | null>(null)
  useEffect(() => { logForTaskIdRef.current = logForTaskId }, [logForTaskId])

  useEffect(() => {
    if (!open) return
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftId])

  // On task change: load detail + usage, clear stale log so the next time the
  // log tab is opened (or if we're already on it) we re-fetch.
  useEffect(() => {
    if (!open || !selectedId) return
    loadDetail(selectedId)
    loadUsage(selectedId)
    setLog(null)
    setLogForTaskId(null)
    setUsage(prev => (prev && prev.task_id === selectedId ? prev : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedId])

  // Whenever the log tab is the active view AND we don't yet have logs for the
  // currently selected task, fetch them. Triggers on tab switch AND on task
  // switch while already on log tab (previously a race left this stale).
  useEffect(() => {
    if (!open || !selectedId || rightTab !== "log") return
    if (logLoading) return
    if (logForTaskId === selectedId) return
    loadLog(selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTab, open, selectedId, logForTaskId])

  useEffect(() => {
    if (!open) {
      setSelectedId(null)
      setDetail(null)
      setLog(null)
      setLogForTaskId(null)
      setUsage(null)
      setRightTab("detail")
    }
  }, [open])

  const selectedTask = tasks.find(t => t.id === selectedId)
  const selectedMeta = selectedTask ? (ROLE_META[selectedTask.assignee] || { icon: FileEdit, label: selectedTask.assignee, accent: "indigo" }) : null

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            工作流轨迹
            <button
              onClick={refresh}
              disabled={loading}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              title="刷新"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            </button>
          </DialogTitle>
          <DialogDescription className="text-xs truncate">
            draft #{draftId} · {draftTitle || "(无标题)"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-3 overflow-hidden -mx-6 px-6 min-h-0">
          {/* ── Left: task list ───────────────────────────────────────── */}
          <div className="w-72 flex-shrink-0 overflow-y-auto space-y-2 px-1 py-0.5">
            {tasks.length === 0 && !loading && (
              <p className="text-center text-xs text-zinc-400 py-8">
                暂无关联任务 · 草稿可能不是从工作室链路产出的
              </p>
            )}
            {tasks.map(t => {
              const meta = ROLE_META[t.assignee] || { icon: FileEdit, label: t.assignee, accent: "indigo" }
              const Icon = meta.icon
              const active = t.id === selectedId
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={cn(
                    "group w-full text-left border rounded-lg p-2.5 transition-all",
                    ACCENT_BG[meta.accent],
                    active && cn("ring-2", ACCENT_RING[meta.accent]),
                    !active && "hover:opacity-80",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className={cn("flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-white", ACCENT_DOT[meta.accent])}>
                      <Icon className="w-3 h-3" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{meta.label}</span>
                        <span className="ml-auto text-[10px] px-1 py-0.5 rounded-full bg-white/60 dark:bg-zinc-900/60 text-zinc-600 dark:text-zinc-400 font-medium">
                          {STATUS_LABEL[t.status] || t.status}
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={e => { e.stopPropagation(); handleDelete(t.id, t.title) }}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleDelete(t.id, t.title) } }}
                          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 transition-all flex-shrink-0 p-0.5 cursor-pointer"
                          title="归档删除"
                        >
                          <Trash2 className="w-3 h-3" />
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-0.5 line-clamp-2 leading-tight">
                        {t.title}
                      </div>
                      <div className="text-[10px] text-zinc-400 mt-1 flex items-center gap-2">
                        <span className="font-mono">{t.id}</span>
                        {t.started_at && <span>· {fmtElapsed(t.started_at, t.completed_at)}</span>}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* ── Right: selected task detail ───────────────────────────── */}
          <div className="flex-1 min-w-0 flex flex-col border-l border-zinc-200 dark:border-zinc-800 pl-3 min-h-0">
            {!selectedTask ? (
              <div className="flex items-center justify-center h-full text-xs text-zinc-400">
                从左侧选一项查看详情
              </div>
            ) : (<>
              {/* Tab bar */}
              <div className="flex gap-0.5 mb-3 flex-shrink-0">
                {([
                  { key: "detail" as const, label: "详情", icon: Activity },
                  { key: "log"    as const, label: "工作日志", icon: ScrollText },
                ] as const).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setRightTab(key)}
                    className={cn(
                      "flex items-center gap-1 px-2.5 py-1 text-[11px] rounded font-medium transition-colors",
                      rightTab === key
                        ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300",
                    )}
                  >
                    <Icon className="w-3 h-3" />{label}
                  </button>
                ))}
                {(detailLoading || logLoading) && <Loader2 className="w-3 h-3 animate-spin text-zinc-400 ml-2 self-center" />}
                {selectedTask?.assignee === 'wms_writer' && (
                  <button
                    onClick={() => setRewriteOpen(v => !v)}
                    className={cn(
                      "ml-auto flex items-center gap-1 px-2 py-1 text-[11px] rounded font-medium border transition-colors",
                      rewriteOpen
                        ? "bg-emerald-100 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300"
                        : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-emerald-300 hover:text-emerald-600",
                    )}
                    title="基于原 brief 重写正文（覆盖当前草稿）"
                  >
                    <RotateCcw className="w-3 h-3" /> 重写
                  </button>
                )}
              </div>

              {rewriteOpen && selectedTask?.assignee === 'wms_writer' && (
                <div className="mb-3 p-2.5 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 flex-shrink-0">
                  <div className="text-[11px] text-zinc-600 dark:text-zinc-300 mb-1.5">
                    重写说明（可空。新 writer 任务会挂在原 editor 之下，复用 brief / core_point，
                    完成后 <code className="px-1 bg-white/60 dark:bg-zinc-900/60 rounded">update_draft</code> 覆盖当前正文）
                  </div>
                  <textarea
                    value={rewriteNote}
                    onChange={e => setRewriteNote(e.target.value)}
                    placeholder="例如：开头太套话，换成具体场景；不要拆 thread；多 1-2 个第一人称当下动作。"
                    className="w-full text-[11px] px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                    rows={3}
                  />
                  <div className="flex items-center justify-end gap-1.5 mt-2">
                    <button
                      onClick={() => { setRewriteOpen(false); setRewriteNote("") }}
                      disabled={rewriteBusy}
                      className="px-2.5 py-1 text-[11px] rounded text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleRewrite}
                      disabled={rewriteBusy}
                      className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                    >
                      {rewriteBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                      确认派单
                    </button>
                  </div>
                </div>
              )}

              {/* Log tab */}
              {rightTab === "log" && (
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                  {logLoading ? (
                    <div className="flex items-center justify-center h-full gap-1.5 text-xs text-zinc-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载日志…
                    </div>
                  ) : (
                    <pre
                      ref={logRef}
                      className="flex-1 min-h-0 overflow-y-auto text-[10.5px] leading-relaxed font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 rounded-md p-2.5 whitespace-pre-wrap break-words"
                    >
                      {log ?? "（暂无日志）"}
                    </pre>
                  )}
                </div>
              )}

              {/* Detail tab */}
              {rightTab === "detail" && (
              <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
                {/* Header */}
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {selectedMeta && (
                      <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md text-white", ACCENT_DOT[selectedMeta.accent])}>
                        <selectedMeta.icon className="w-3 h-3" />
                        {selectedMeta.label}
                      </span>
                    )}
                    <span className="text-[11px] text-zinc-400 font-mono">{selectedTask.id}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-medium">
                      {STATUS_LABEL[selectedTask.status] || selectedTask.status}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 leading-snug">
                    {selectedTask.title}
                  </h3>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-400 mt-1.5">
                    <span>创建 {fmtDtSec(selectedTask.created_at)}</span>
                    {selectedTask.started_at && <span>开始 {fmtDtSec(selectedTask.started_at)}</span>}
                    {selectedTask.completed_at && <span>完成 {fmtDtSec(selectedTask.completed_at)}</span>}
                    {selectedTask.started_at && <span>耗时 {fmtElapsed(selectedTask.started_at, selectedTask.completed_at)}</span>}
                  </div>
                </div>

                {/* Latest summary */}
                {(detail?.latest_summary || selectedTask.latest_summary) && (
                  <section>
                    <h4 className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1.5">最新摘要</h4>
                    <div className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap bg-zinc-50 dark:bg-zinc-900 rounded-md p-2.5">
                      {detail?.latest_summary || selectedTask.latest_summary}
                    </div>
                  </section>
                )}

                {/* Body */}
                {detail?.task?.body && (
                  <section>
                    <h4 className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1.5">任务正文</h4>
                    <pre className="text-[11px] text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap break-words bg-zinc-50 dark:bg-zinc-900 rounded-md p-2.5 font-sans">
                      {detail.task.body}
                    </pre>
                  </section>
                )}

                {/* Token usage */}
                {usage && usage.task_id === selectedTask.id && (usage.total_input + usage.total_output) > 0 && (
                  <section>
                    <h4 className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1.5 flex items-center gap-1">
                      <Coins className="w-3 h-3" /> Token 消耗
                    </h4>
                    <div className="grid grid-cols-4 gap-1.5 text-[11px]">
                      <UsageStat label="输入" value={fmtTokens(usage.total_input)} accent="text-blue-600 dark:text-blue-400" />
                      <UsageStat label="输出" value={fmtTokens(usage.total_output)} accent="text-emerald-600 dark:text-emerald-400" />
                      <UsageStat label="缓存读" value={fmtTokens(usage.total_cache_read)} accent="text-zinc-500" />
                      <UsageStat label="花费" value={fmtUsd(usage.total_cost_usd)} accent="text-amber-600 dark:text-amber-400 font-mono" />
                    </div>
                    {usage.runs.length > 1 && (
                      <details className="mt-1.5 text-[10px]">
                        <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 select-none">
                          分 run 明细（{usage.runs.length}）
                        </summary>
                        <div className="mt-1 space-y-1">
                          {usage.runs.map((r, i) => (
                            <div key={i} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-800 font-mono">
                              <span className="text-zinc-400 w-7">#{r.run_id ?? '?'}</span>
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
                  </section>
                )}

                {/* Runs */}
                {detail && detail.runs.length > 0 && (
                  <section>
                    <h4 className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1.5 flex items-center gap-1">
                      <Activity className="w-3 h-3" /> 运行记录（{detail.runs.length}）
                    </h4>
                    <div className="space-y-1.5">
                      {detail.runs.map((r, i) => (
                        <div key={r.run_id ?? i} className="text-[11px] bg-zinc-50 dark:bg-zinc-900 rounded-md p-2">
                          <div className="flex items-center gap-2 text-zinc-500 mb-1">
                            <span className="font-mono">#{r.run_id ?? '?'}</span>
                            {r.outcome && (
                              <span className={cn(
                                "px-1 py-0.5 rounded text-[9px] font-semibold uppercase",
                                r.outcome === "success" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400" :
                                r.outcome === "blocked" ? "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400" :
                                "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                              )}>
                                {r.outcome}
                              </span>
                            )}
                            {r.elapsed_seconds != null && <span className="text-[10px]">耗时 {r.elapsed_seconds}s</span>}
                            <span className="ml-auto text-[10px]">{fmtDtSec(r.started_at)}</span>
                          </div>
                          {r.summary && (
                            <div className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{r.summary}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Comments */}
                {detail && detail.comments.length > 0 && (
                  <section>
                    <h4 className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1.5 flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" /> 留言（{detail.comments.length}）
                    </h4>
                    <div className="space-y-1.5">
                      {detail.comments.map((c, i) => (
                        <div key={i} className="text-[11px] bg-zinc-50 dark:bg-zinc-900 rounded-md p-2">
                          <div className="flex items-center gap-2 text-zinc-500 mb-0.5">
                            <span className="font-medium text-zinc-700 dark:text-zinc-300">{c.author}</span>
                            <span className="ml-auto text-[10px]">{fmtDtSec(c.created_at)}</span>
                          </div>
                          <div className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{c.body}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Events */}
                {detail && detail.events.length > 0 && (
                  <section>
                    <h4 className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1.5">事件日志（{detail.events.length}）</h4>
                    <div className="space-y-1">
                      {detail.events.map((e, i) => (
                        <div key={i} className="text-[10px] flex items-start gap-2 py-1 border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                          <span className="text-zinc-400 font-mono w-28 flex-shrink-0">{fmtDtSec(e.created_at)}</span>
                          <span className="font-medium text-zinc-600 dark:text-zinc-400 w-14 flex-shrink-0">
                            {EVENT_LABEL[e.kind] || e.kind}
                          </span>
                          {e.payload && (
                            <span className="text-zinc-500 dark:text-zinc-400 break-all flex-1 min-w-0">
                              {JSON.stringify(e.payload).slice(0, 240)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
              )}
            </>)}
          </div>
        </div>

        <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800 -mx-6 px-6">
          <a
            href="/studio"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 flex items-center gap-1 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            打开工作室看板
          </a>
        </div>
      </DialogContent>
    </Dialog>
  )
}
