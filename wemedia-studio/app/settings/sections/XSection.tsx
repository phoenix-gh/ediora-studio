'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { AppSettings, updateSettings } from '@/lib/api/settings'
import { listPublishAccounts, type PublishAccount } from '@/lib/api/publish-accounts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { TelegramSettingsCard } from './TelegramSettingsCard'
import { XCredentialAccountsCard } from './XCredentialAccountsCard'

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [xInterval, setXInterval] = useState(settings?.x_collect_interval_minutes ?? 15)
  const [notifyEnabled, setNotifyEnabled] = useState(settings?.x_notify_enabled ?? true)
  const [responseAccountId, setResponseAccountId] = useState(settings?.x_response_account_id ?? '')
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    listPublishAccounts()
      .then(nextAccounts => {
        if (cancelled) return
        setAccounts(nextAccounts)
      })
      .catch(() => { if (!cancelled) setAccounts([]) })
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        x_collect_interval_minutes: xInterval,
        x_notify_enabled: notifyEnabled,
        x_response_account_id: responseAccountId,
      })
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
          本项目通过 feedgrab 采集 X 内容，并在下方管理可轮换的采集账号。
        </p>
      </div>

      <XCredentialAccountsCard />
      <TelegramSettingsCard settings={settings} onSaved={onSaved} />

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

        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="x-response-account">建议使用的发布账号画像</Label>
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
