'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

  return <div className="space-y-4">
    <p className="text-xs leading-5 text-zinc-500">`fetch_url` 会依次尝试已启用的抓取器，成功后停止。抓取结果最多返回 12,000 个字符。</p>
    {providers.map((provider, index) => <div key={provider.key} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="text-sm font-medium">{DETAILS[provider.key].title}</h2><p className="mt-1 text-xs text-zinc-500">{DETAILS[provider.key].description}</p></div>
        <div className="flex items-center gap-1"><Button type="button" size="icon-xs" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} title="提高优先级"><ArrowUp /></Button><Button type="button" size="icon-xs" variant="ghost" disabled={index === providers.length - 1} onClick={() => move(index, 1)} title="降低优先级"><ArrowDown /></Button><label className="ml-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={provider.enabled} onChange={event => updateProvider(index, { enabled: event.target.checked })} />启用</label></div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_9rem]">
        {provider.key === 'jina_reader' ? <div className="space-y-1.5"><Label className="text-xs">Jina Reader Base URL</Label><Input value={provider.base_url} onChange={event => updateProvider(index, { base_url: event.target.value })} placeholder="https://r.jina.ai" className="h-9 font-mono text-sm" /></div> : <div className="text-xs text-zinc-500">{provider.key === 'camofox' ? '浏览器地址和凭据复用 X / Twitter 设置。' : '无需额外连接配置。'}</div>}
        <div className="space-y-1.5"><Label className="text-xs">超时（秒）</Label><Input type="number" min={1} max={30} value={provider.timeout_seconds} onChange={event => updateProvider(index, { timeout_seconds: Math.max(1, Math.min(30, Number(event.target.value) || 1)) })} className="h-9" /></div>
      </div>
    </div>)}
    <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存网页抓取设置</Button>
  </div>
}
