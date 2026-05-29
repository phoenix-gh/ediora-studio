"use client"

import { useEffect, useMemo, useState } from "react"
import { Bookmark, BookmarkCheck, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  WritingPlan,
  addPlanSource,
  flattenTopicsWithDepth,
  getWritingPlans,
} from "@/lib/api/writing-plans"
import { Draft, getDrafts } from "@/lib/api/drafts"

interface Props {
  url: string
  title: string
  summary?: string
  platform: string
  className?: string
  label?: string
}

export function AddToTopicPopover({ url, title, summary = "", platform, className, label }: Props) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  const [plans, setPlans] = useState<WritingPlan[] | null>(null)
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [planId, setPlanId] = useState<number | null>(null)
  const [draftId, setDraftId] = useState<number | null>(null)
  const [note, setNote] = useState(summary)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || plans) return
    let cancelled = false
    Promise.all([getWritingPlans(), getDrafts()])
      .then(([p, d]) => {
        if (cancelled) return
        setPlans(p)
        setDrafts(d.filter(x => x.status === "drafting"))
      })
      .catch(() => toast.error("加载写作方案/草稿失败"))
    return () => { cancelled = true }
  }, [open, plans])

  // Reset note when summary changes (different content trigger)
  useEffect(() => { setNote(summary) }, [summary])

  const flatPlans = useMemo(() => {
    if (!plans) return []
    const all = flattenTopicsWithDepth(plans).filter(t => t.plan.status === "active")
    if (!query.trim()) return all
    const q = query.trim().toLowerCase()
    return all.filter(t => t.plan.title.toLowerCase().includes(q))
  }, [plans, query])

  const planDrafts = useMemo(() => {
    if (!drafts || planId == null) return []
    return drafts.filter(d => d.writing_plan_id === planId)
  }, [drafts, planId])

  async function handleSubmit() {
    if (!planId) {
      toast.error("请先选择写作方案")
      return
    }
    setBusy(true)
    try {
      await addPlanSource(planId, {
        url, title, note, platform,
        draft_id: draftId ?? undefined,
      })
      toast.success(draftId ? "已加到写作方案和草稿" : "已加到写作方案")
      setDone(true)
      setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "添加失败")
    } finally {
      setBusy(false)
    }
  }

  function handleOpenChange(o: boolean) {
    setOpen(o)
    if (o) {
      // Reset selection state each time the popover opens
      setPlanId(null)
      setDraftId(null)
      setQuery("")
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={done ? "已加为线索" : "加为写作方案线索"}
            onClick={e => e.stopPropagation()}
            className={cn(
              "inline-flex items-center justify-center rounded-md text-zinc-400 hover:text-indigo-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors",
              label ? "gap-1 h-7 px-2 text-[11px]" : "w-7 h-7",
              done && "text-indigo-500",
              className,
            )}
          />
        }
      >
        {done ? <BookmarkCheck className="w-3.5 h-3.5" /> : <Bookmark className="w-3.5 h-3.5" />}
        {label && <span>{done ? "已加为线索" : label}</span>}
      </PopoverTrigger>
      <PopoverContent
        className="w-80"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">写作方案</div>
            <Input
              placeholder="搜索写作方案…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="h-8 text-xs mb-1.5"
            />
            <div className="max-h-40 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-md">
              {plans === null ? (
                <div className="p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> 加载中
                </div>
              ) : flatPlans.length === 0 ? (
                <div className="p-3 text-center text-xs text-zinc-400">无匹配写作方案</div>
              ) : (
                flatPlans.map(({ plan, depth }) => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => { setPlanId(plan.id); setDraftId(null) }}
                    className={cn(
                      "w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors truncate",
                      planId === plan.id && "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400",
                    )}
                    style={{ paddingLeft: `${8 + depth * 12}px` }}
                  >
                    {plan.title}
                  </button>
                ))
              )}
            </div>
          </div>

          {planId != null && (
            <div>
              <div className="text-xs font-medium text-zinc-500 mb-1.5">草稿（可选）</div>
              <div className="max-h-32 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-md">
                {planDrafts.length === 0 ? (
                  <div className="p-2 text-center text-xs text-zinc-400">该写作方案下暂无进行中草稿</div>
                ) : (
                  planDrafts.map(d => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDraftId(draftId === d.id ? null : d.id)}
                      className={cn(
                        "w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors truncate",
                        draftId === d.id && "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400",
                      )}
                    >
                      {d.title || `草稿 #${d.id}`}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">备注（可选）</div>
            <Input
              placeholder="对这条线索的备注"
              value={note}
              onChange={e => setNote(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={busy || planId == null}
            >
              {busy && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              添加
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
