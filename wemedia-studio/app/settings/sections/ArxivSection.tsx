'use client'

import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
    <FormSection
      title="arXiv 数据源"
      description="按分类读取 arXiv RSS，适合定时采集论文更新。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="arxiv-categories">采集分类</FieldLabel>
        <Input
          id="arxiv-categories"
          value={categories}
          onChange={e => setCategories(e.target.value)}
          placeholder="cs.AI,cs.CL,cs.CV,cs.LG"
          className="font-mono"
        />
          <FieldDescription>
          多个分类用英文逗号分隔，常用：cs.AI · cs.CL · cs.CV · cs.LG · cs.RO · stat.ML
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="arxiv-interval">采集间隔</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            id="arxiv-interval"
            type="number" min={1} max={168}
            value={interval}
            onChange={e => setInterval(Math.max(1, Number(e.target.value)))}
            className="w-24"
          />
            <span className="text-sm text-muted-foreground">小时</span>
        </div>
          <FieldDescription>arXiv RSS 每天更新一次，建议设置 6-24 小时。</FieldDescription>
        </Field>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          保存
        </Button>
      </FieldGroup>
    </FormSection>
  )
}
