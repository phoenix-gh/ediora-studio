'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { getXAuthStatus, type XAuthStatus } from '@/lib/api/x'
import { AppSettings, updateSettings } from '@/lib/api/settings'
import { listPublishAccounts, type PublishAccount } from '@/lib/api/publish-accounts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [status, setStatus] = useState<XAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const [xInterval, setXInterval] = useState(settings?.x_collect_interval_minutes ?? 15)
  const [notifyEnabled, setNotifyEnabled] = useState(settings?.x_notify_enabled ?? true)
  const [telegramToken, setTelegramToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState(settings?.telegram_chat_id ?? '')
  const [responseAccountId, setResponseAccountId] = useState(settings?.x_response_account_id ?? '')
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getXAuthStatus().catch(() => ({ ready: false, hint: '无法连接后端 /api/x/auth-status' })),
      listPublishAccounts().catch(() => []),
    ])
      .then(([nextStatus, nextAccounts]) => {
        if (cancelled) return
        setStatus(nextStatus)
        setAccounts(nextAccounts)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        x_collect_interval_minutes: xInterval,
        x_notify_enabled: notifyEnabled,
        ...(telegramToken.trim() ? { telegram_bot_token: telegramToken.trim() } : {}),
        telegram_chat_id: telegramChatId.trim(),
        x_response_account_id: responseAccountId,
      })
      setTelegramToken('')
      onSaved(updated)
      toast.success('X 采集配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Auth status */}
      <div>
        <h2 className="text-base font-medium">X / Twitter (feedgrab)</h2>
        <p className="text-sm text-muted-foreground">
          本项目通过 feedgrab 采集 X 内容，认证完全交由 feedgrab 管理。
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">认证状态：</span>
          {loading ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 检查中…
            </span>
          ) : status?.ready ? (
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="size-4" /> 已就绪
            </span>
          ) : (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="size-4" /> 未登录
            </span>
          )}
        </div>
        {status?.hint && (
          <p className="mt-1 text-xs text-muted-foreground">{status.hint}</p>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 text-sm font-medium">如何登录</p>
        <p className="mb-2 text-xs text-muted-foreground">在 backend 启动目录任选其一：</p>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
{`# 方法 1：交互式浏览器登录（推荐）
feedgrab login twitter

# 方法 2：环境变量（在 backend 启动前导出）
export X_AUTH_TOKEN=...
export X_CT0=...`}
        </pre>
      </div>

      {/* Interval settings */}
      <div className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs">即时响应总开关</Label>
            <Switch checked={notifyEnabled} onCheckedChange={(v) => setNotifyEnabled(v)} />
          </div>
          <p className="text-[11px] text-zinc-400">
            开启后，已勾选「即时响应」的时间线订阅会生成中文评论或翻译引用建议。高价值建议即时推送，其他候选在 18:00 汇总。
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div>
            <p className="text-sm font-medium">Telegram 推送</p>
            <p className="text-[11px] text-zinc-400">
              Token 只写不回显。当前状态：{settings?.telegram_bot_token_set
                ? `已配置 ${settings.telegram_bot_token_preview}`
                : '未配置'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="telegram-bot-token">Telegram Bot Token</Label>
            <Input
              id="telegram-bot-token"
              type="password"
              autoComplete="new-password"
              value={telegramToken}
              onChange={event => setTelegramToken(event.target.value)}
              placeholder={settings?.telegram_bot_token_set ? '留空则保留当前 Token' : '123456:ABC…'}
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="telegram-chat-id">Telegram Chat ID</Label>
            <Input
              id="telegram-chat-id"
              value={telegramChatId}
              onChange={event => setTelegramChatId(event.target.value)}
              placeholder="-1001234567890"
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="x-response-account">建议基于账号</Label>
            <select
              id="x-response-account"
              value={responseAccountId}
              onChange={event => setResponseAccountId(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">使用默认中文科技账号画像</option>
              {accounts
                .filter(account => account.is_active && ['x', 'twitter'].includes(account.platform.toLowerCase()))
                .map(account => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">X 订阅采集间隔</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={1440}
              value={xInterval}
              onChange={e => setXInterval(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-24"
            />
            <span className="text-sm text-zinc-500">分钟</span>
          </div>
          <p className="text-[11px] text-zinc-400">多久从 X 订阅拉取一次原始推文（存入 x_posts）</p>
        </div>

        <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          保存
        </Button>
      </div>
    </div>
  )
}
