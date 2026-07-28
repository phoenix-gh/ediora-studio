'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { type AppSettings, type WebSearchProviderConfig, updateSettings } from '@/lib/api/settings'

const DEFAULT_PROVIDER: WebSearchProviderConfig = {
  key: 'searxng', enabled: false, base_url: '', timeout_seconds: 12,
}

export function WebSearchSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (settings: AppSettings) => void }) {
  const initial = settings?.web_search_providers.find(provider => provider.key === 'searxng') ?? DEFAULT_PROVIDER
  const [enabled, setEnabled] = useState(initial.enabled)
  const [baseUrl, setBaseUrl] = useState(initial.base_url)
  const [timeout, setTimeout] = useState(initial.timeout_seconds)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        web_search_providers: [{
          key: 'searxng', enabled, base_url: baseUrl.trim(), timeout_seconds: Math.max(1, Math.min(30, timeout)),
        }],
      })
      onSaved(updated)
      toast.success('Web 搜索设置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormSection
      title="SearXNG"
      description="Chat 的 `web_search` 工具会通过此自托管搜索实例检索公开网页。"
      actions={(
        <div className="flex items-center gap-2">
          <Label htmlFor="searxng-enabled">启用 SearXNG</Label>
          <Switch
            id="searxng-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      )}
    >
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <Field>
            <FieldLabel htmlFor="searxng-base-url">SearXNG Base URL</FieldLabel>
            <Input
              id="searxng-base-url"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder="http://searxng:8080"
              className="font-mono"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="searxng-timeout">超时（秒）</FieldLabel>
            <Input
              id="searxng-timeout"
              type="number"
              min={1}
              max={30}
              value={timeout}
              onChange={event => setTimeout(Number(event.target.value) || 1)}
            />
          </Field>
        </div>
        <FieldDescription>
          搜索会按 provider 优先级自动降级。当前已接入 SearXNG；后续搜索引擎会沿用同一优先级机制。
        </FieldDescription>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          保存 Web 搜索设置
        </Button>
      </FieldGroup>
    </FormSection>
  )
}
