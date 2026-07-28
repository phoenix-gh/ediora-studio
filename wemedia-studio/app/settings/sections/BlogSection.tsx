'use client'

import { useState } from 'react'
import { Loader2, Eye, EyeOff, CheckCircle, Save } from 'lucide-react'
import { toast } from 'sonner'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
    <FormSection
      title="MK Flow 投稿接口"
      description="配置博客根地址和只写的 Agent API Token。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="blog-api-base">接口地址</FieldLabel>
        <Input
          id="blog-api-base"
          value={base}
          onChange={e => setBase(e.target.value)}
          placeholder="https://mkflow.dev"
            className="font-mono"
          autoComplete="off"
        />
          <FieldDescription>
          博客站点根地址，投稿走 {base.trim().replace(/\/$/, '') || 'https://mkflow.dev'}/api/agent/posts
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="blog-api-token">Agent API Token</FieldLabel>
          <div className="flex gap-2">
          <Input
              id="blog-api-token"
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={
              settings?.blog_api_token_set
                ? `已配置 (${settings.blog_api_token_preview}) — 留空不修改`
                : '博客服务器 .env 里的 AGENT_API_TOKEN'
            }
              className="font-mono"
            autoComplete="off"
          />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label={showToken ? '隐藏 Agent API Token' : '显示 Agent API Token'}
              onClick={() => setShowToken(value => !value)}
            >
              {showToken ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        {settings?.blog_api_token_set && !token ? (
            <FieldDescription className="flex items-center gap-1 text-foreground">
              <CheckCircle />
              已配置 ({settings.blog_api_token_preview})
            </FieldDescription>
        ) : (
            <FieldDescription>
            也可以在后端环境变量 MKFLOW_AGENT_API_TOKEN 里配置；此处填写后优先生效
            </FieldDescription>
        )}
        </Field>

        <FieldDescription>
        投稿后文章进入博客后台 review 状态，人工审核确认后才会发布。
        </FieldDescription>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          保存
        </Button>
      </FieldGroup>
    </FormSection>
  )
}
