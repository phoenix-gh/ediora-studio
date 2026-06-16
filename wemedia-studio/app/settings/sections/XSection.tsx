'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { getXAuthStatus, type XAuthStatus } from '@/lib/api/x'
import { AppSettings, updateSettings } from '@/lib/api/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function XSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [status, setStatus] = useState<XAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const [xInterval, setXInterval] = useState(settings?.x_collect_interval_minutes ?? 15)
  const [collectInterval, setCollectInterval] = useState(settings?.ref_collect_interval_minutes ?? 15)
  const [cleanInterval, setCleanInterval] = useState(settings?.ref_classify_interval_minutes ?? 30)
  const [batchSize, setBatchSize] = useState(settings?.clean_batch_size ?? 20)
  const [notifyEnabled, setNotifyEnabled] = useState(settings?.x_notify_enabled ?? true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    getXAuthStatus()
      .then((s) => { if (!cancelled) setStatus(s) })
      .catch(() => { if (!cancelled) setStatus({ ready: false, hint: '无法连接后端 /api/x/auth-status' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        x_collect_interval_minutes: xInterval,
        x_notify_enabled: notifyEnabled,
        ref_collect_interval_minutes: collectInterval,
        ref_classify_interval_minutes: cleanInterval,
        clean_batch_size: batchSize,
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
      {/* Auth status */}
      <div>
        <h2 className="text-base font-medium">X / Twitter (feedgrab)</h2>
        <p className="text-sm text-muted-foreground">
          本项目通过 feedgrab 采集 X 内容，认证完全交由 feedgrab 管理。
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">认证状态：</span>
          {loading ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 检查中…
            </span>
          ) : status?.ready ? (
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="size-4" /> 已就绪
            </span>
          ) : (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="size-4" /> 未登录
            </span>
          )}
        </div>
        {status?.hint && (
          <p className="mt-1 text-xs text-muted-foreground">{status.hint}</p>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 text-sm font-medium">如何登录</p>
        <p className="mb-2 text-xs text-muted-foreground">在 backend 启动目录任选其一：</p>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
{`# 方法 1：交互式浏览器登录（推荐）
feedgrab login twitter

# 方法 2：环境变量（在 backend 启动前导出）
export X_AUTH_TOKEN=...
export X_CT0=...`}
        </pre>
      </div>

      {/* Interval settings */}
      <div className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs">回复关注提醒</Label>
            <Switch checked={notifyEnabled} onCheckedChange={(v) => setNotifyEnabled(v)} />
          </div>
          <p className="text-[11px] text-zinc-400">
            开启后，已勾选「动态通知」的 X 订阅出新帖时，经 LLM 评回复价值并附建议，推送到 Telegram。关闭则全局停止所有此类提醒。
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">X 订阅采集间隔</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={1440}
              value={xInterval}
              onChange={e => setXInterval(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-24"
            />
            <span className="text-sm text-zinc-500">分钟</span>
          </div>
          <p className="text-[11px] text-zinc-400">多久从 X 订阅拉取一次原始推文（存入 x_posts）</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">素材采集间隔</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={1440}
              value={collectInterval}
              onChange={e => setCollectInterval(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-24"
            />
            <span className="text-sm text-zinc-500">分钟</span>
          </div>
          <p className="text-[11px] text-zinc-400">多久按采集规则（赞数/天数过滤）筛一次推文，规则清洗打分后直接入素材库</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">素材分类间隔</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={5} max={1440}
              value={cleanInterval}
              onChange={e => setCleanInterval(Math.max(5, Number(e.target.value)))}
              className="h-9 text-sm w-24"
            />
            <span className="text-sm text-zinc-500">分钟</span>
          </div>
          <p className="text-[11px] text-zinc-400">多久给高分未分类素材补一次分类标签（LLM 低频，节省 token）</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">每批清洗条数</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={200}
              value={batchSize}
              onChange={e => setBatchSize(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-24"
            />
            <span className="text-sm text-zinc-500">条</span>
          </div>
          <p className="text-[11px] text-zinc-400">每次清洗最多处理多少条 raw 素材（推理模型建议 1–5）</p>
        </div>

        <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          保存
        </Button>
      </div>
    </div>
  )
}
