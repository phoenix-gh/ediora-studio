'use client'

import {
  Bell,
  BellOff,
  Bird,
  Ellipsis,
  FolderInput,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { fmtRelTime } from '@/lib/format'
import type { XSubscription } from '@/lib/api/x'
import { cn } from '@/lib/utils'

export type XSubscriptionRowProps = {
  subscription: XSubscription
  enabledRuleCount: number
  busy: boolean
  collecting: boolean
  screening: boolean
  editing?: boolean
  editValue?: string
  onEditValueChange?: (value: string) => void
  onCommitEdit?: () => void
  onCancelEdit?: () => void
  onToggle: (subscription: XSubscription) => void
  onCollect: (subscription: XSubscription) => void
  onEdit: (subscription: XSubscription) => void
  onToggleNotify: (subscription: XSubscription) => void
  onConfigureIngestion: (subscription: XSubscription) => void
  onScreen: (subscription: XSubscription) => void
  onBackfill: (subscription: XSubscription) => void
  onDelete: (subscription: XSubscription) => void
}

export function XSubscriptionRow({
  subscription,
  enabledRuleCount,
  busy,
  collecting,
  screening,
  editing = false,
  editValue = '',
  onEditValueChange,
  onCommitEdit,
  onCancelEdit,
  onToggle,
  onCollect,
  onEdit,
  onToggleNotify,
  onConfigureIngestion,
  onScreen,
  onBackfill,
  onDelete,
}: XSubscriptionRowProps) {
  const label = subscription.label || '未命名'
  const disabled = busy || collecting

  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-0 sm:flex-row sm:items-center',
        !subscription.enabled && 'opacity-60',
      )}
      data-testid={`x-subscription-${subscription.id}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Bird className={cn('mt-0.5 size-4 shrink-0', subscription.enabled ? 'text-sky-500' : 'text-muted-foreground')} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              autoFocus
              aria-label={`订阅名称：${label}`}
              value={editValue}
              onChange={event => onEditValueChange?.(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') onCommitEdit?.()
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  onCancelEdit?.()
                }
              }}
              className="h-7 text-xs"
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-medium">{label}</span>
              <Badge variant={subscription.kind === 'search' ? 'ai' : 'data'} className="h-4 px-1.5 text-[10px]">
                {subscription.kind === 'search' ? '搜索' : '时间线'}
              </Badge>
            </div>
          )}
          <p className="mt-0.5 line-clamp-2 break-all font-mono text-[11px] leading-4 text-muted-foreground" title={subscription.kind === 'search' ? subscription.raw_query : subscription.url ?? ''}>
            {subscription.kind === 'search' ? subscription.raw_query : subscription.url}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {subscription.post_count} 帖 · {subscription.last_collected_at ? `${fmtRelTime(subscription.last_collected_at)} 采集` : '未采集'}
            {subscription.last_error ? <span className="ml-1 text-destructive">⚠ {subscription.last_error}</span> : null}
          </p>
          <p className="text-[11px] leading-4 text-muted-foreground">素材入库：{enabledRuleCount} 个目录规则</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5 self-end sm:self-center">
        <Switch
          size="sm"
          aria-label={`启用订阅：${label}`}
          checked={subscription.enabled}
          onCheckedChange={() => onToggle(subscription)}
          disabled={disabled}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onCollect(subscription)}
        >
          {collecting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
          {collecting ? '采集中' : '采集'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" size="icon-sm" variant="ghost" />}
            aria-label={`更多操作：${label}`}
            disabled={disabled}
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => onEdit(subscription)}>
                <Pencil />
                编辑订阅
              </DropdownMenuItem>
              {subscription.kind === 'timeline' ? (
                <DropdownMenuItem onClick={() => onToggleNotify(subscription)}>
                  {subscription.notify_new_posts ? <BellOff /> : <Bell />}
                  {subscription.notify_new_posts ? '关闭即时响应' : '开启即时响应'}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => onConfigureIngestion(subscription)}>
                <FolderInput />
                配置素材入库
              </DropdownMenuItem>
              <DropdownMenuItem disabled={screening} onClick={() => onScreen(subscription)}>
                {screening ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {screening ? 'AI 筛选中' : 'AI 筛选入库'}
              </DropdownMenuItem>
              {subscription.kind === 'timeline' ? (
                <DropdownMenuItem onClick={() => onBackfill(subscription)}>
                  <History />
                  回溯采集
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(subscription)}>
                <Trash2 />
                删除订阅
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
