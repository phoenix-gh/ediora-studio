'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle, Save } from 'lucide-react'
import { toast } from 'sonner'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
    <FormSection
      title="GitHub API"
      description="配置可选令牌与仓库、Trending 采集频率。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="github-token">Personal Access Token</FieldLabel>
          <div className="flex gap-2">
          <Input
              id="github-token"
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={
              settings?.github_token_set
                ? `已配置 (${settings.github_token_preview}) — 留空不修改`
                : '留空以匿名模式运行（60次/小时限流）'
            }
              className="font-mono"
            autoComplete="off"
          />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={showToken ? '隐藏 GitHub Token' : '显示 GitHub Token'}
              onClick={() => setShowToken(value => !value)}
            >
              {showToken ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        {settings?.github_token_set && !token ? (
            <FieldDescription className="flex items-center gap-1 text-foreground">
              <CheckCircle />
              已配置 ({settings.github_token_preview}) · 5000次/小时
            </FieldDescription>
        ) : (
            <FieldDescription>
            在 GitHub → Settings → Developer settings → Personal access tokens 创建（仅需 public_repo read 权限）
            </FieldDescription>
        )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="github-interval">采集调度间隔</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
                id="github-interval"
              type="number" min={1} max={1440}
              value={githubInterval}
              onChange={e => setGithubInterval(Math.max(1, Number(e.target.value)))}
                className="w-24"
            />
              <span className="text-sm text-muted-foreground">分钟</span>
          </div>
            <FieldDescription>调度器 tick 间隔，每个仓库有自己的采集频率。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="github-trending-interval">Trending 刷新间隔</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
                id="github-trending-interval"
              type="number" min={1} max={168}
              value={trendingInterval}
              onChange={e => setTrendingInterval(Math.max(1, Number(e.target.value)))}
                className="w-24"
            />
              <span className="text-sm text-muted-foreground">小时</span>
          </div>
            <FieldDescription>GitHub Trending 抓取频率。</FieldDescription>
          </Field>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          保存
        </Button>
      </FieldGroup>
    </FormSection>
  )
}
