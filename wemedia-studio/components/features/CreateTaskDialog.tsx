"use client"

import { useEffect, useState } from "react"
import { Loader2, PenLine, Plus } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import { listPublishAccounts, PublishAccount } from "@/lib/api/publish-accounts"
import { ManualGenre } from "@/lib/api/studio"
import { createJob } from "@/lib/api/jobs"

const GENRES: { value: ManualGenre; label: string }[] = [
  { value: "commentary", label: "评论" },
  { value: "tutorial", label: "教程" },
  { value: "story", label: "故事" },
  { value: "review", label: "测评" },
]

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
  const [errors, setErrors] = useState<{ accountId?: string; title?: string }>({})

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
    setErrors({})
  }

  async function handleSubmit() {
    const nextErrors = {
      accountId: accountId ? undefined : "请选择发布账号",
      title: title.trim() ? undefined : "请填写主题",
    }
    setErrors(nextErrors)
    if (nextErrors.accountId || nextErrors.title) {
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
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <PenLine className="text-primary" />
            发布创作任务
          </DialogTitle>
          <DialogDescription>
            自拟主题后，系统会先生成 brief，再生成可编辑的草稿。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="gap-4">
          <Field data-invalid={Boolean(errors.accountId)}>
            <FieldTitle id="task-account-choices-label">发布账号 <span aria-hidden="true">*</span></FieldTitle>
            <div
              aria-labelledby="task-account-choices-label"
              className="max-h-36 overflow-y-auto rounded-md border border-border bg-surface"
              role="group"
            >
              {accounts === null ? (
                <div className="flex items-center justify-center gap-1 p-3 text-xs text-muted-foreground">
                  <Loader2 className="animate-spin" /> 加载中
                </div>
              ) : accounts.length === 0 ? (
                <div className="p-3 text-center text-xs text-muted-foreground">
                  暂无启用账号 · 去「设置 → 发布账号」配置
                </div>
              ) : (
                accounts.map(a => (
                  <Button
                    key={a.id}
                    type="button"
                    variant={accountId === a.id ? "secondary" : "ghost"}
                    aria-pressed={accountId === a.id}
                    onClick={() => {
                      setAccountId(a.id)
                      setErrors(current => ({ ...current, accountId: undefined }))
                    }}
                    className="h-auto w-full justify-start rounded-none px-2 py-1.5 text-left text-xs first:rounded-t-md last:rounded-b-md"
                  >
                    <div className="font-medium truncate">{a.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {a.platform} · {a.positioning || "（无定位描述）"}
                    </div>
                  </Button>
                ))
              )}
            </div>
            <FieldError>{errors.accountId}</FieldError>
          </Field>

          <Field data-invalid={Boolean(errors.title)}>
            <FieldLabel htmlFor="task-title">主题 *</FieldLabel>
            <Input
              id="task-title"
              placeholder="比如「为什么本地优先软件又火了」"
              value={title}
              onChange={e => {
                setTitle(e.target.value)
                setErrors(current => ({ ...current, title: undefined }))
              }}
              aria-invalid={Boolean(errors.title)}
            />
            <FieldError>{errors.title}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-idea">想法与素材（可选）</FieldLabel>
            <Textarea
              id="task-idea"
              value={idea}
              onChange={e => setIdea(e.target.value)}
              placeholder="写下你的角度、想法，或粘贴参考素材；留空则由策划编辑自己搜料"
              rows={5}
            />
          </Field>

          <Field>
            <FieldTitle id="task-genre-choices-label">体裁</FieldTitle>
            <div aria-labelledby="task-genre-choices-label" className="grid grid-cols-4 gap-1.5" role="group">
              {GENRES.map(g => (
                <Button
                  key={g.value}
                  type="button"
                  onClick={() => setGenre(g.value)}
                  variant={genre === g.value ? "default" : "outline"}
                  aria-pressed={genre === g.value}
                  size="sm"
                  className="w-full"
                >
                  {g.label}
                </Button>
              ))}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="task-note">备注（可选）</FieldLabel>
            <Input
              id="task-note"
              placeholder="给策划编辑的额外指令，比如「别写成科普」"
              value={note}
              onChange={e => setNote(e.target.value)}
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={busy}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
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
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" />
        发布创作任务
      </Button>
      <CreateTaskDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
