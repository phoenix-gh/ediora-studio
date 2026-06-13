'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AppSettings, updateSettings } from '@/lib/api/settings'

export function BlogSection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const [base, setBase]           = useState(settings?.blog_api_base ?? 'https://mkflow.dev')
  const [token, setToken]         = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving]       = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        blog_api_base: base.trim(),
        ...(token ? { blog_api_token: token } : {}),
      })
      onSaved(updated)
      setToken('')
      toast.success('Blog 投稿配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">接口地址</Label>
        <Input
          value={base}
          onChange={e => setBase(e.target.value)}
          placeholder="https://mkflow.dev"
          className="h-9 text-sm font-mono"
          autoComplete="off"
        />
        <p className="text-[11px] text-zinc-400">
          博客站点根地址，投稿走 {base.trim().replace(/\/$/, '') || 'https://mkflow.dev'}/api/agent/posts
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Agent API Token</Label>
        <div className="relative">
          <Input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={
              settings?.blog_api_token_set
                ? `已配置 (${settings.blog_api_token_preview}) — 留空不修改`
                : '博客服务器 .env 里的 AGENT_API_TOKEN'
            }
            className="h-9 text-sm pr-9 font-mono"
            autoComplete="off"
          />
          <button type="button" onClick={() => setShowToken(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
            {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        {settings?.blog_api_token_set && !token ? (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />已配置 ({settings.blog_api_token_preview})
          </p>
        ) : (
          <p className="text-[11px] text-zinc-400">
            也可以在后端环境变量 MKFLOW_AGENT_API_TOKEN 里配置；此处填写后优先生效
          </p>
        )}
      </div>

      <p className="text-[11px] text-zinc-400">
        投稿后文章进入博客后台 review 状态，人工审核确认后才会发布。
      </p>

      <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        保存
      </Button>
    </div>
  )
}
