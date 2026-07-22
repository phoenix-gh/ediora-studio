"use client"

import { useEffect, useState } from "react"
import { Loader2, PenLine, Plus } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { listPublishAccounts, PublishAccount } from "@/lib/api/publish-accounts"
import { ManualGenre } from "@/lib/api/studio"
import { createJob } from "@/lib/api/jobs"

const GENRES: { value: ManualGenre; label: string }[] = [
  { value: "commentary", label: "评论" },
  { value: "tutorial", label: "教程" },
  { value: "story", label: "故事" },
  { value: "review", label: "测评" },
]

const TEXTAREA_CLS =
  "w-full resize-none rounded-lg border border-zinc-200 dark:border-zinc-700 " +
  "bg-white dark:bg-zinc-900 px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 " +
  "placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 手动发布创作任务弹窗：用户自拟主题 + 可选想法/素材，走 manual_topic 链路。 */
export function CreateTaskDialog({ open, onOpenChange }: Props) {
  const [accounts, setAccounts] = useState<PublishAccount[] | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [idea, setIdea] = useState("")
  const [genre, setGenre] = useState<ManualGenre>("commentary")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || accounts) return
    let cancelled = false
    listPublishAccounts()
      .then(list => { if (!cancelled) setAccounts(list.filter(a => a.is_active)) })
      .catch(() => toast.error("加载发布账号失败"))
    return () => { cancelled = true }
  }, [open, accounts])

  function reset() {
    setAccountId(null)
    setTitle("")
    setIdea("")
    setGenre("commentary")
    setNote("")
  }

  async function handleSubmit() {
    if (!accountId) {
      toast.error("请选择发布账号")
      return
    }
    if (!title.trim()) {
      toast.error("请填写主题")
      return
    }
    setBusy(true)
    try {
      const res = await createJob({
        flow: "draft",
        title: title.trim(),
        input: {
          account_id: accountId,
          idea: idea.trim(),
          genre,
          note: note.trim(),
        },
        idempotency_key: crypto.randomUUID(),
      })
      toast.success(`已创建创作任务 · #${res.id}`)
      reset()
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "发布失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <PenLine className="w-4 h-4 text-indigo-500" />
            发布创作任务
          </DialogTitle>
          <DialogDescription>
            自拟主题后，系统会先生成 brief，再生成可编辑的草稿。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">发布账号 *</div>
            <div className="max-h-36 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-md">
              {accounts === null ? (
                <div className="p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> 加载中
                </div>
              ) : accounts.length === 0 ? (
                <div className="p-3 text-center text-xs text-zinc-400">
                  暂无启用账号 · 去「设置 → 发布账号」配置
                </div>
              ) : (
                accounts.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAccountId(a.id)}
                    className={cn(
                      "w-full text-left px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors",
                      accountId === a.id && "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300",
                    )}
                  >
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="text-[10px] text-zinc-400 truncate">
                      {a.platform} · {a.positioning || "（无定位描述）"}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">主题 *</div>
            <Input
              placeholder="比如「为什么本地优先软件又火了」"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">想法与素材（可选）</div>
            <textarea
              value={idea}
              onChange={e => setIdea(e.target.value)}
              placeholder="写下你的角度、想法，或粘贴参考素材；留空则由策划编辑自己搜料"
              rows={5}
              className={TEXTAREA_CLS}
            />
          </div>

          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">体裁</div>
            <div className="grid grid-cols-4 gap-1.5">
              {GENRES.map(g => (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setGenre(g.value)}
                  className={cn(
                    "py-1.5 rounded-md border text-xs transition-colors",
                    genre === g.value
                      ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-medium"
                      : "border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-300 dark:hover:border-zinc-700",
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-zinc-500 mb-1.5">备注（可选）</div>
            <Input
              placeholder="给策划编辑的额外指令，比如「别写成科普」"
              value={note}
              onChange={e => setNote(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={busy || !accountId || !title.trim()}>
            {busy && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
            发布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 自带触发按钮的封装（工作台 header 用）。 */
export function CreateTaskButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="gap-1.5">
        <Plus className="w-3.5 h-3.5" />
        发布创作任务
      </Button>
      <CreateTaskDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
