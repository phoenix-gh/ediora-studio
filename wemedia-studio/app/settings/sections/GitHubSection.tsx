'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppSettings, updateSettings } from '@/lib/api/settings'

export function GitHubSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [token, setToken]                   = useState('')
  const [showToken, setShowToken]           = useState(false)
  const [githubInterval, setGithubInterval] = useState(settings?.github_interval_minutes ?? 1)
  const [trendingInterval, setTrendingInterval] = useState(settings?.github_trending_interval_hours ?? 6)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        github_interval_minutes: githubInterval,
        github_trending_interval_hours: trendingInterval,
        ...(token ? { github_token: token } : {}),
      })
      onSaved(updated)
      setToken('')
      toast.success('GitHub 配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Token */}
      <div className="space-y-1.5">
        <Label className="text-xs">Personal Access Token</Label>
        <div className="relative">
          <Input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={
              settings?.github_token_set
                ? `已配置 (${settings.github_token_preview}) — 留空不修改`
                : '留空以匿名模式运行（60次/小时限流）'
            }
            className="h-9 text-sm pr-9 font-mono"
            autoComplete="off"
          />
          <button type="button" onClick={() => setShowToken(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
            {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        {settings?.github_token_set && !token ? (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />已配置 ({settings.github_token_preview}) · 5000次/小时
          </p>
        ) : (
          <p className="text-[11px] text-zinc-400">
            在 GitHub → Settings → Developer settings → Personal access tokens 创建（仅需 public_repo read 权限）
          </p>
        )}
      </div>

      {/* Intervals */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Issues 采集间隔</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={1440}
              value={githubInterval}
              onChange={e => setGithubInterval(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-20"
            />
            <span className="text-sm text-zinc-500">分钟</span>
          </div>
          <p className="text-[11px] text-zinc-400">调度器 tick 间隔，每个仓库有自己的采集频率</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Trending 刷新间隔</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} max={168}
              value={trendingInterval}
              onChange={e => setTrendingInterval(Math.max(1, Number(e.target.value)))}
              className="h-9 text-sm w-20"
            />
            <span className="text-sm text-zinc-500">小时</span>
          </div>
          <p className="text-[11px] text-zinc-400">GitHub Trending 抓取频率</p>
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        保存
      </Button>
    </div>
  )
}
