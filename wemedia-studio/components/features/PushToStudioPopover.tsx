"use client"

import { useEffect, useState } from "react"
import { Send, Loader2, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { listPublishAccounts, PublishAccount } from "@/lib/api/publish-accounts"
import { enqueueStudioTask } from "@/lib/api/studio"

interface Props {
  url: string
  title: string
  summary?: string
  content?: string
  platform: string
  className?: string
  label?: string
}

export function PushToStudioPopover({ url, title, summary = "", content = "", platform, className, label }: Props) {
  const [open, setOpen] = useState(false)
  const [accounts, setAccounts] = useState<PublishAccount[] | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!open || accounts) return
    let cancelled = false
    listPublishAccounts()
      .then(list => { if (!cancelled) setAccounts(list.filter(a => a.is_active)) })
      .catch(() => toast.error("加载发布账号失败"))
    return () => { cancelled = true }
  }, [open, accounts])

  function handleOpenChange(o: boolean) {
    setOpen(o)
    if (o) {
      setAccountId(null)
      setNote("")
    }
  }

  async function handleSubmit() {
    if (!accountId) {
      toast.error("请选择发布账号")
      return
    }
    setBusy(true)
    try {
      const res = await enqueueStudioTask({
        account_id: accountId,
        title,
        source_url: url,
        platform,
        summary,
        note,
        content,
      })
      toast.success(`已推送到工作室 · ${res.task_id}`)
      setDone(true)
      setOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "推送失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={done ? "已推送到工作室" : "推送到工作室"}
            onClick={e => e.stopPropagation()}
            className={cn(
              "inline-flex items-center justify-center rounded-md text-foreground-subtle hover:text-emerald-500 hover:bg-muted transition-colors",
              label ? "gap-1 h-7 px-2 text-[11px]" : "w-7 h-7",
              done && "text-emerald-500",
              className,
            )}
          />
        }
      >
        {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
        {label && <span>{done ? "已推送" : label}</span>}
      </PopoverTrigger>
      <PopoverContent
        className="w-80"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">发布账号</div>
            <div className="max-h-48 overflow-y-auto border border-border rounded-md">
              {accounts === null ? (
                <div className="p-3 text-center text-xs text-foreground-subtle flex items-center justify-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> 加载中
                </div>
              ) : accounts.length === 0 ? (
                <div className="p-3 text-center text-xs text-foreground-subtle">
                  暂无启用账号 · 去「设置 → 发布账号」配置
                </div>
              ) : (
                accounts.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAccountId(a.id)}
                    className={cn(
                      "w-full text-left px-2 py-1.5 text-xs hover:bg-muted transition-colors",
                      accountId === a.id && "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-[10px] text-foreground-subtle truncate">
                      {a.platform} · {a.positioning || "（无定位描述）"}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">备注（可选）</div>
            <Input
              placeholder="给 scout 的额外指令，比如「侧重批判视角」"
              value={note}
              onChange={e => setNote(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={busy || !accountId}>
              {busy && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
              推送
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
