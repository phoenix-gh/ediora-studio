'use client'

import { useState } from 'react'
import {
  Check, Clipboard, ExternalLink, FileInput, Loader2, MessageSquareReply,
  RefreshCw, ShieldCheck, ShieldQuestion, X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  convertXResponseToTopic,
  listXResponses,
  setXResponseFeedback,
  type XResponseDecision,
  type XResponseWorkflowStatus,
} from '@/lib/api/x-responses'


const ACTION_LABEL: Record<XResponseDecision['action'], string> = {
  comment: '评论',
  translate_quote: '翻译引用',
  watch: '观察',
  ignore: '忽略',
}

const ACTION_COLOR: Record<XResponseDecision['action'], string> = {
  comment: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  translate_quote: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  watch: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  ignore: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
}

type InboxFilter = 'ready' | 'all'

export function XResponsesClient({ initialItems }: { initialItems: XResponseDecision[] }) {
  const [items, setItems] = useState(initialItems)
  const [filter, setFilter] = useState<InboxFilter>('ready')
  const [loading, setLoading] = useState(false)
  const [actingId, setActingId] = useState<number | null>(null)

  async function reload(nextFilter: InboxFilter = filter) {
    setLoading(true)
    try {
      const result = await listXResponses(
        nextFilter === 'ready' ? { workflow_status: 'ready' } : {},
      )
      setItems(result.items)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function applyMutation(
    id: number,
    mutation: () => Promise<XResponseDecision>,
    success: string,
  ) {
    setActingId(id)
    try {
      const updated = await mutation()
      setItems(current => (
        filter === 'ready' && updated.workflow_status !== 'ready'
          ? current.filter(item => item.id !== id)
          : current.map(item => item.id === id ? updated : item)
      ))
      toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setActingId(null)
    }
  }

  async function copyDraft(item: XResponseDecision) {
    const draft = item.comment_draft ?? item.quote_draft
    if (!draft) return
    await navigator.clipboard.writeText(draft)
    toast.success('草稿已复制')
  }

  function changeFilter(next: InboxFilter) {
    setFilter(next)
    void reload(next)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50/50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <MessageSquareReply className="size-5 text-indigo-500" />
              <h1 className="text-lg font-semibold">X 待响应</h1>
            </div>
            <p className="mt-1 text-xs text-zinc-400">
              统一中文建议，仅供复制后手动发布；系统不会自动操作 X。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        </div>
        <div className="mt-3 flex gap-1">
          {([
            ['ready', '待处理'],
            ['all', '全部记录'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => changeFilter(value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs',
                filter === value
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {items.length === 0 ? (
          <div className="flex h-48 items-center justify-center rounded-xl border border-dashed text-sm text-zinc-400">
            暂无待响应内容
          </div>
        ) : (
          <div className="mx-auto grid max-w-5xl gap-4">
            {items.map(item => (
              <ResponseCard
                key={item.id}
                item={item}
                busy={actingId === item.id}
                onCopy={() => copyDraft(item)}
                onStatus={(status) => applyMutation(
                  item.id,
                  () => setXResponseFeedback(item.id, status),
                  status === 'used' ? '已标记采用' : '已忽略',
                )}
                onConvert={() => applyMutation(
                  item.id,
                  () => convertXResponseToTopic(item.id),
                  '已转为选题',
                )}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function ResponseCard({
  item, busy, onCopy, onStatus, onConvert,
}: {
  item: XResponseDecision
  busy: boolean
  onCopy: () => void
  onStatus: (status: 'used' | 'ignored') => void
  onConvert: () => void
}) {
  const draft = item.comment_draft ?? item.quote_draft
  const verificationText = item.verification_status === 'verified'
    ? '链接已核验'
    : item.verification_status === 'unverified' ? '链接未核验' : '无需外链核验'
  const telegramText = telegramStatusText(item)
  const requiresTelegramInspection = (
    item.telegram_status === 'sending'
    || item.telegram_status === 'unknown'
  )

  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', ACTION_COLOR[item.action])}>
              {ACTION_LABEL[item.action]}
            </span>
            <span className="text-sm font-semibold">评分 {item.score}</span>
            <span className="text-xs text-zinc-500">置信度 {Math.round(item.confidence * 100)}%</span>
          </div>
          <p className="mt-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">{item.reason}</p>
          <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{item.summary_cn}</p>
        </div>
        <span className="text-xs text-zinc-400">{item.source_label} · @{item.username}</span>
      </div>

      <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-xs leading-5 text-zinc-500 dark:bg-zinc-950/60">
        {item.post_content}
      </div>

      {draft ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500">可复制中文草稿</span>
            <button type="button" onClick={onCopy} className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-500">
              <Clipboard className="size-3.5" />复制
            </button>
          </div>
          <pre className="select-text whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white p-3 text-sm leading-6 dark:border-zinc-700 dark:bg-zinc-950">
            {draft}
          </pre>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        <span className="flex items-center gap-1">
          {item.verification_status === 'verified'
            ? <ShieldCheck className="size-3.5 text-emerald-500" />
            : <ShieldQuestion className="size-3.5" />}
          核验：{verificationText}
        </span>
        <span>Telegram：{telegramText}</span>
        <span>状态：{workflowLabel(item.workflow_status)}</span>
        <a href={item.post_url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 hover:text-sky-500">
          查看原帖 <ExternalLink className="size-3.5" />
        </a>
      </div>

      {requiresTelegramInspection ? (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <div>请先人工核对 Telegram，再决定是否处理后续任务。</div>
          {item.telegram_message_ids.length > 0 ? (
            <div className="mt-1">
              已知消息 ID：{item.telegram_message_ids.join('、')}
            </div>
          ) : null}
          {item.telegram_last_error ? (
            <div className="mt-1 break-words">{item.telegram_last_error}</div>
          ) : null}
        </div>
      ) : null}

      {item.workflow_status === 'ready' ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onStatus('ignored')}>
            <X className="size-3.5" />忽略
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onConvert}>
            <FileInput className="size-3.5" />转为选题
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onStatus('used')}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            已采用
          </Button>
        </div>
      ) : null}
    </article>
  )
}

function workflowLabel(status: XResponseWorkflowStatus) {
  if (status === 'used') return '已采用'
  if (status === 'ignored') return '已忽略'
  if (status === 'converted') return '已转选题'
  return '待处理'
}

function telegramStatusText(item: XResponseDecision) {
  if (item.telegram_status === 'sent') return 'Telegram 已推送'
  if (item.telegram_status === 'sending') return '推送中'
  if (item.telegram_status === 'unknown') return '投递状态待确认'
  if (item.notification_tier === 'digest') return '等待 18:00 摘要'
  return '未推送'
}
