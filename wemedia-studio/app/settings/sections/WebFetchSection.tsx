'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { type AppSettings, type WebFetchProviderConfig, updateSettings } from '@/lib/api/settings'

const DEFAULT_PROVIDERS: WebFetchProviderConfig[] = [
  { key: 'direct', enabled: true, base_url: '', timeout_seconds: 12 },
  { key: 'jina_reader', enabled: true, base_url: 'https://r.jina.ai', timeout_seconds: 20 },
  { key: 'camofox', enabled: true, base_url: '', timeout_seconds: 30 },
]

const DETAILS: Record<WebFetchProviderConfig['key'], { title: string; description: string }> = {
  direct: { title: '直接抓取', description: '直接请求公开网页并提取正文，适合作为第一优先级。' },
  jina_reader: { title: 'Jina Reader', description: '通过 Reader 服务提取正文，适合复杂网页。' },
  camofox: { title: 'Camofox 浏览器', description: '使用已配置浏览器渲染 JavaScript 页面，作为最终降级。' },
}

export function WebFetchSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (settings: AppSettings) => void }) {
  const configuredProviders = settings?.web_fetch_providers ?? []
  const saved = new Map(configuredProviders.map(provider => [provider.key, provider]))
  const [providers, setProviders] = useState(() => (configuredProviders.length
    ? configuredProviders
    : DEFAULT_PROVIDERS).map(provider => ({ ...provider, ...saved.get(provider.key) })))
  const [saving, setSaving] = useState(false)

  function updateProvider(index: number, patch: Partial<WebFetchProviderConfig>) {
    setProviders(current => current.map((provider, currentIndex) => currentIndex === index ? { ...provider, ...patch } : provider))
  }

  function move(index: number, direction: -1 | 1) {
    setProviders(current => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({ web_fetch_providers: providers })
      onSaved(updated)
      toast.success('网页抓取设置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        `fetch_url` 会依次尝试已启用的抓取器，成功后停止。抓取结果最多返回 12,000 个字符。
      </p>
      {providers.map((provider, index) => {
        const title = DETAILS[provider.key].title
        const enabledId = `web-fetch-${provider.key}-enabled`
        const baseUrlId = `web-fetch-${provider.key}-base-url`
        const timeoutId = `web-fetch-${provider.key}-timeout`
        return (
          <FormSection
            key={provider.key}
            title={title}
            description={DETAILS[provider.key].description}
            actions={(
              <>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`提高 ${title} 优先级`}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={index === providers.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`降低 ${title} 优先级`}
                >
                  <ArrowDown />
                </Button>
                <Label htmlFor={enabledId}>启用 {title}</Label>
                <Switch
                  id={enabledId}
                  checked={provider.enabled}
                  onCheckedChange={checked => updateProvider(index, { enabled: checked })}
                />
              </>
            )}
          >
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                {provider.key === 'jina_reader' ? (
                  <Field>
                    <FieldLabel htmlFor={baseUrlId}>Jina Reader Base URL</FieldLabel>
                    <Input
                      id={baseUrlId}
                      value={provider.base_url}
                      onChange={event => updateProvider(index, { base_url: event.target.value })}
                      placeholder="https://r.jina.ai"
                      className="font-mono"
                    />
                  </Field>
                ) : (
                  <FieldDescription>
                    {provider.key === 'camofox'
                      ? '浏览器地址和凭据复用 X / Twitter 设置。'
                      : '无需额外连接配置。'}
                  </FieldDescription>
                )}
                <Field>
                  <FieldLabel htmlFor={timeoutId}>超时（秒）</FieldLabel>
                  <Input
                    id={timeoutId}
                    type="number"
                    min={1}
                    max={30}
                    value={provider.timeout_seconds}
                    onChange={event => updateProvider(index, {
                      timeout_seconds: Math.max(1, Math.min(30, Number(event.target.value) || 1)),
                    })}
                  />
                </Field>
              </div>
            </FieldGroup>
          </FormSection>
        )
      })}
      <Button onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
        保存网页抓取设置
      </Button>
    </div>
  )
}
