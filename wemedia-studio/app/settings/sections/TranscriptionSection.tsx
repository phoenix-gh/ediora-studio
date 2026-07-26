'use client'

import { useState } from 'react'
import { FlaskConical, Loader2, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  type AppSettings,
  testTranscription,
  updateSettings,
} from '@/lib/api/settings'


export function TranscriptionSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved(settings: AppSettings): void
}) {
  const [model, setModel] = useState(settings?.transcription_model ?? 'whisper-1')
  const [baseUrl, setBaseUrl] = useState(settings?.transcription_base_url ?? 'https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [maxMinutes, setMaxMinutes] = useState(Math.round((settings?.transcription_max_duration_seconds ?? 7200) / 60))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  async function save(clear = false) {
    setSaving(true)
    try {
      const updated = await updateSettings({
        transcription_provider: 'openai-compatible',
        transcription_model: model,
        transcription_base_url: baseUrl,
        transcription_api_key: clear ? undefined : apiKey,
        transcription_clear_api_key: clear,
        transcription_max_duration_seconds: Math.max(1, maxMinutes) * 60,
      })
      onSaved(updated)
      setApiKey('')
      toast.success(clear ? '转写 API Key 已清除' : '语音转写配置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      const result = await testTranscription()
      if (result.ok) toast.success('转写服务连接正常')
      else toast.error(result.error)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>语音转写</CardTitle>
        <CardDescription>
          视频没有人工或自动字幕时，才调用此 OpenAI 兼容 Whisper 接口。它与聊天模型配置相互独立。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="transcription-base-url">Base URL</FieldLabel>
            <Input id="transcription-base-url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="transcription-model">模型</FieldLabel>
            <Input id="transcription-model" value={model} onChange={event => setModel(event.target.value)} placeholder="whisper-1" />
          </Field>
          <Field>
            <FieldLabel htmlFor="transcription-api-key">API Key</FieldLabel>
            <Input
              id="transcription-api-key"
              type="password"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={settings?.transcription_api_key_set
                ? `已配置 (${settings.transcription_api_key_preview})，留空保持不变`
                : '输入语音转写 API Key'}
              autoComplete="off"
            />
            <FieldDescription>密钥只保存在服务端，不会写入任务、日志或浏览器响应。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="transcription-max-minutes">单视频最长分钟数</FieldLabel>
            <Input id="transcription-max-minutes" type="number" min={1} value={maxMinutes} onChange={event => setMaxMinutes(Number(event.target.value))} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={saving || !baseUrl.trim() || !model.trim()}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />} 保存
            </Button>
            <Button variant="outline" onClick={() => void test()} disabled={testing || !settings?.transcription_api_key_set}>
              {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />} 测试连接
            </Button>
            {settings?.transcription_api_key_set && (
              <Button variant="ghost" onClick={() => void save(true)} disabled={saving}>
                <Trash2 /> 清除密钥
              </Button>
            )}
          </div>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
