'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  buildCoverStyleFromEditor,
  CoverStyleEditor,
} from '@/components/features/CoverStyleEditor'
import {
  listPublishAccounts,
  type CoverStyle,
  type PublishAccount,
} from '@/lib/api/publish-accounts'

export type BulkImageMode = 'cover' | 'illustrations'

export type BulkImageOptions =
  | { mode: 'cover'; accountId: string; note: string; coverStyle?: CoverStyle }
  | { mode: 'illustrations'; accountId: string; note: string; maxImages: number }

interface Props {
  open: boolean
  mode: BulkImageMode
  selectedCount: number
  running: boolean
  progress: { completed: number; total: number }
  failures: Array<{ title: string; reason?: string }>
  onClose: () => void
  onSubmit: (options: BulkImageOptions) => void
}

const UNSET_ACCOUNT_VALUE = '__bulk_account_unset__'

export function BulkImageActionDialog({
  open,
  mode,
  selectedCount,
  running,
  progress,
  failures,
  onClose,
  onSubmit,
}: Props) {
  const [accounts, setAccounts] = useState<PublishAccount[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [coverStyle, setCoverStyle] = useState<CoverStyle>({})
  const [motifsText, setMotifsText] = useState('')
  const [negativeText, setNegativeText] = useState('')
  const [maxImages, setMaxImages] = useState(4)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listPublishAccounts()
      .then(list => {
        if (!cancelled) {
          setAccounts(list.filter(account => account.is_active))
          setLoadError('')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAccounts([])
          setLoadError('加载发布账号失败')
        }
      })
    return () => { cancelled = true }
  }, [open])

  function selectAccount(nextAccountId: string | null) {
    setAccountId(nextAccountId)
    if (!nextAccountId || !accounts) return
    const account = accounts.find(item => item.id === nextAccountId)
    const style = account?.cover_style ?? {}
    setCoverStyle({
      type: style.type,
      palette: style.palette,
      rendering: style.rendering,
      text: style.text,
      mood: style.mood,
      aspect_ratio: style.aspect_ratio,
    })
    setMotifsText((style.signature_motifs ?? []).join('\n'))
    setNegativeText((style.negative ?? []).join('\n'))
  }

  function submit() {
    if (!accountId || running) return
    if (mode === 'cover') {
      const builtStyle = buildCoverStyleFromEditor(coverStyle, motifsText, negativeText)
      onSubmit({
        mode,
        accountId,
        note: note.trim(),
        coverStyle: Object.keys(builtStyle).length > 0 ? builtStyle : undefined,
      })
      return
    }
    onSubmit({
      mode,
      accountId,
      note: note.trim(),
      maxImages: Math.max(1, Math.min(4, maxImages)),
    })
  }

  const title = mode === 'cover' ? '批量生成封面' : '批量生成插图'
  const submitLabel = mode === 'cover' ? '开始批量封面' : '开始批量插图'
  const progressValue = progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : 0
  const accountItems = [
    { label: '（选择账号）', value: UNSET_ACCOUNT_VALUE },
    ...(accounts ?? []).map(account => ({
      label: `${account.name}（${account.platform}）`,
      value: account.id,
    })),
  ]

  return (
    <Dialog open={open} onOpenChange={nextOpen => {
      if (!nextOpen && !running) onClose()
    }}>
      <DialogContent size="md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            为已选 {selectedCount} 组草稿统一设置参数；任务只派发给文章主版本。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="bulk-image-account">发布账号</FieldLabel>
            <Select
              items={accountItems}
              value={accountId ?? UNSET_ACCOUNT_VALUE}
              onValueChange={value => selectAccount(
                value === UNSET_ACCOUNT_VALUE || typeof value !== 'string' ? null : value,
              )}
            >
              <SelectTrigger id="bulk-image-account" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {accountItems.map(item => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          {accounts === null && !loadError ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />加载发布账号
            </p>
          ) : null}

          {loadError ? (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : null}

          {accounts?.length === 0 && !loadError ? (
            <Alert>
              <AlertDescription>暂无启用账号，请先前往“设置 → 发布账号”配置。</AlertDescription>
            </Alert>
          ) : null}

          {mode === 'cover' && accountId ? (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                封面风格覆盖
              </summary>
              <div className="border-t border-border p-3">
                <CoverStyleEditor
                  coverStyle={coverStyle}
                  onCoverStyleChange={setCoverStyle}
                  motifsText={motifsText}
                  onMotifsTextChange={setMotifsText}
                  negativeText={negativeText}
                  onNegativeTextChange={setNegativeText}
                />
              </div>
            </details>
          ) : null}

          {mode === 'illustrations' ? (
            <Field>
              <FieldLabel htmlFor="bulk-image-max">每篇最多插图</FieldLabel>
              <Input
                id="bulk-image-max"
                type="number"
                min={1}
                max={4}
                value={maxImages}
                onChange={event => setMaxImages(
                  Math.max(1, Math.min(4, Number(event.target.value) || 1)),
                )}
              />
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="bulk-image-note">额外指令</FieldLabel>
            <Input
              id="bulk-image-note"
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder={mode === 'cover' ? '如：冷色调、不要文字' : '如：偏插画、解释章节结构'}
            />
          </Field>
        </FieldGroup>

        {running || progress.completed > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span>{running ? '正在提交任务' : '任务提交结果'}</span>
              <span className="text-muted-foreground">{progress.completed} / {progress.total}</span>
            </div>
            <Progress value={progressValue} aria-label="批量任务进度" />
          </div>
        ) : null}

        {failures.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>未完成 {failures.length} 组</AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {failures.map(failure => (
                  <li key={`${failure.title}-${failure.reason ?? ''}`}>
                    <span className="font-medium">{failure.title || '（无标题）'}</span>
                    {failure.reason ? `：${failure.reason}` : ''}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>取消</Button>
          <Button onClick={submit} disabled={running || !accountId || accounts === null}>
            {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
