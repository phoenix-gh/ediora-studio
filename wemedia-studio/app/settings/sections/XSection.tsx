'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { AppSettings, updateSettings } from '@/lib/api/settings'
import { listPublishAccounts, type PublishAccount } from '@/lib/api/publish-accounts'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { TelegramSettingsCard } from './TelegramSettingsCard'
import { XCredentialAccountsCard } from './XCredentialAccountsCard'

const DEFAULT_ACCOUNT_VALUE = '__default_account__'

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [xInterval, setXInterval] = useState(settings?.x_collect_interval_minutes ?? 15)
  const [notifyEnabled, setNotifyEnabled] = useState(settings?.x_notify_enabled ?? true)
  const [responseAccountId, setResponseAccountId] = useState<string | null>(settings?.x_response_account_id || null)
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
        x_response_account_id: responseAccountId ?? '',
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
      <p className="text-sm text-muted-foreground">
        本项目通过 feedgrab 采集 X 内容，并在下方管理可轮换的采集账号。
      </p>

      <XCredentialAccountsCard />
      <TelegramSettingsCard settings={settings} onSaved={onSaved} />

      <FormSection
        title="采集与响应"
        description="控制 X 订阅采集频率、即时响应和建议使用的发布账号画像。"
      >
        <FieldGroup>
          <Field orientation="horizontal">
            <div>
              <Label htmlFor="x-notify-enabled">即时响应总开关</Label>
              <FieldDescription>
            开启后，已勾选「即时响应」的时间线订阅会生成中文评论或翻译引用建议。高价值建议即时推送，其他候选在 18:00 汇总。
              </FieldDescription>
            </div>
            <Switch
              id="x-notify-enabled"
              checked={notifyEnabled}
              onCheckedChange={setNotifyEnabled}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="x-response-account">建议使用的发布账号画像</FieldLabel>
            <Select
              value={responseAccountId ?? DEFAULT_ACCOUNT_VALUE}
              onValueChange={value => setResponseAccountId(
                !value || value === DEFAULT_ACCOUNT_VALUE ? null : value
              )}
            >
              <SelectTrigger id="x-response-account" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={DEFAULT_ACCOUNT_VALUE}>使用默认中文科技账号画像</SelectItem>
                  {accounts
                    .filter(account => account.is_active && ['x', 'twitter'].includes(account.platform.toLowerCase()))
                    .map(account => (
                      <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                    ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="x-collect-interval">X 订阅采集间隔</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
                id="x-collect-interval"
              type="number" min={1} max={1440}
              value={xInterval}
              onChange={e => setXInterval(Math.max(1, Number(e.target.value)))}
                className="w-24"
            />
              <span className="text-sm text-muted-foreground">分钟</span>
          </div>
            <FieldDescription>多久从 X 订阅拉取一次原始推文（存入 x_posts）。</FieldDescription>
          </Field>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          保存
        </Button>
        </FieldGroup>
      </FormSection>
    </div>
  )
}
