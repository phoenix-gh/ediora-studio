'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

  return <div className="space-y-5">
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="text-sm font-medium">SearXNG</h2><p className="mt-1 text-xs text-zinc-500">Chat 的 `web_search` 工具会通过此自托管搜索实例检索公开网页。</p></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_9rem]">
        <div className="space-y-1.5"><Label htmlFor="searxng-base-url" className="text-xs">SearXNG Base URL</Label><Input id="searxng-base-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://searxng:8080" className="h-9 font-mono text-sm" /></div>
        <div className="space-y-1.5"><Label htmlFor="searxng-timeout" className="text-xs">超时（秒）</Label><Input id="searxng-timeout" type="number" min={1} max={30} value={timeout} onChange={event => setTimeout(Number(event.target.value) || 1)} className="h-9" /></div>
      </div>
    </div>
    <p className="text-xs leading-5 text-zinc-500">搜索会按 provider 优先级自动降级。当前已接入 SearXNG；后续搜索引擎会沿用同一优先级机制。</p>
    <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存 Web 搜索设置</Button>
  </div>
}
