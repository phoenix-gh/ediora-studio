'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppSettings, updateSettings } from '@/lib/api/settings'

export function ArxivSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [categories, setCategories] = useState(settings?.arxiv_categories ?? 'cs.AI,cs.CL,cs.CV,cs.LG')
  const [interval, setInterval] = useState(settings?.arxiv_collect_interval_hours ?? 6)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        arxiv_categories: categories,
        arxiv_collect_interval_hours: interval,
      })
      onSaved(updated)
      toast.success('arXiv 配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">采集分类</Label>
        <Input
          value={categories}
          onChange={e => setCategories(e.target.value)}
          placeholder="cs.AI,cs.CL,cs.CV,cs.LG"
          className="h-9 text-sm font-mono"
        />
        <p className="text-[11px] text-zinc-400">
          多个分类用英文逗号分隔，常用：cs.AI · cs.CL · cs.CV · cs.LG · cs.RO · stat.ML
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">采集间隔</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number" min={1} max={168}
            value={interval}
            onChange={e => setInterval(Math.max(1, Number(e.target.value)))}
            className="h-9 text-sm w-20"
          />
          <span className="text-sm text-zinc-500">小时</span>
        </div>
        <p className="text-[11px] text-zinc-400">arXiv RSS 每天更新一次，建议设置 6-24 小时</p>
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        保存
      </Button>
    </div>
  )
}
