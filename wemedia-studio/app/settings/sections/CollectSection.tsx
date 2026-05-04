'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppSettings, updateSettings } from '@/lib/api/settings'

export function CollectSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [rsshub, setRsshub]               = useState(settings?.rsshub_base ?? 'http://127.0.0.1:1200')
  const [collectInterval, setCollectInterval] = useState(settings?.collect_interval_minutes ?? 15)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        rsshub_base: rsshub,
        collect_interval_minutes: collectInterval,
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
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">RSSHub 地址</Label>
        <Input
          value={rsshub}
          onChange={e => setRsshub(e.target.value)}
          placeholder="http://127.0.0.1:1200"
          className="h-9 text-sm font-mono"
        />
        <p className="text-[11px] text-zinc-400">
          将 X / 知乎 / 微博等平台转换为 RSS 源，可使用本地部署或公共实例地址
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">RSS / YouTube 采集间隔</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number" min={1} max={1440}
            value={collectInterval}
            onChange={e => setCollectInterval(Math.max(1, Number(e.target.value)))}
            className="h-9 text-sm w-24"
          />
          <span className="text-sm text-zinc-500">分钟</span>
          <span className="text-[11px] text-zinc-400">同时触发 AI 分析</span>
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        保存
      </Button>
    </div>
  )
}
