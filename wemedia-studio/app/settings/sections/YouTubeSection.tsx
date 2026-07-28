'use client'

import { useState } from 'react'
import { Loader2, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { type AppSettings, updateSettings } from '@/lib/api/settings'


export function YouTubeSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved(settings: AppSettings): void
}) {
  const [cookies, setCookies] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(value: string, successMessage: string) {
    setSaving(true)
    try {
      const updated = await updateSettings({ youtube_cookies: value })
      onSaved(updated)
      setCookies('')
      toast.success(successMessage)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'YouTube Cookie 保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormSection
      title="YouTube Cookie"
      description="为 yt-dlp 提供已登录的 YouTube 会话，降低字幕下载触发 429 的概率。Cookie 仅保存在服务端，不会回显。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="youtube-cookies">cookies.txt</FieldLabel>
          <Textarea
            id="youtube-cookies"
            value={cookies}
            onChange={event => setCookies(event.target.value)}
            placeholder={'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t…'}
            rows={10}
            autoComplete="off"
          />
          <FieldDescription>
            从已登录 YouTube 的浏览器导出 Netscape 格式 cookies.txt 后，将完整内容粘贴在此处。
            {settings?.youtube_cookies_set ? ' 当前已配置。' : ' 当前未配置。'}
          </FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save(cookies, 'YouTube Cookie 已保存')} disabled={saving || !cookies.trim()}>
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
            保存 Cookie
          </Button>
          {settings?.youtube_cookies_set && (
            <Button variant="ghost" onClick={() => void save('', 'YouTube Cookie 已清除')} disabled={saving}>
              <Trash2 data-icon="inline-start" />
              清除 Cookie
            </Button>
          )}
        </div>
      </FieldGroup>
    </FormSection>
  )
}
