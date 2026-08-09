'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { AppSettings, updateSettings } from '@/lib/api/settings'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { TelegramSettingsCard } from './TelegramSettingsCard'
import { XCredentialAccountsCard } from './XCredentialAccountsCard'

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [xInterval, setXInterval] = useState(settings?.x_collect_interval_minutes ?? 15)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        x_collect_interval_minutes: xInterval,
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
        title="默认采集配置"
        description="控制新建 X 订阅的默认采集频率；已有订阅可在订阅管理中单独设置。"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="x-collect-interval">新订阅默认采集间隔</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="x-collect-interval"
                type="number" min={5} max={1440}
                value={xInterval}
                onChange={e => setXInterval(Math.max(5, Number(e.target.value)))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">分钟</span>
            </div>
            <FieldDescription>新建订阅时使用的默认值；保存后不影响已有订阅。</FieldDescription>
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
