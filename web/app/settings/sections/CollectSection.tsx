'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { AppSettings, updateSettings } from '@/lib/api/settings'
import { CollectionProxyForm } from './CollectionProxyForm'

export function CollectSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [rsshub, setRsshub]               = useState(settings?.rsshub_base ?? 'http://127.0.0.1:1200')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        rsshub_base: rsshub,
      })
      onSaved(updated)
      toast.success('采集配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FormSection
        title="RSSHub"
        description="将 X / 知乎 / 微博等平台转换为 RSS 源，可使用本地部署或公共实例地址。"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="rsshub-base">RSSHub 地址</FieldLabel>
            <Input
              id="rsshub-base"
              value={rsshub}
              onChange={e => setRsshub(e.target.value)}
              placeholder="http://127.0.0.1:1200"
              className="font-mono"
            />
            <FieldDescription>地址会按原样保存，便于使用容器内或本机地址。</FieldDescription>
          </Field>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
            保存
          </Button>
        </FieldGroup>
      </FormSection>
      <CollectionProxyForm settings={settings} onSaved={onSaved} />
    </div>
  )
}
