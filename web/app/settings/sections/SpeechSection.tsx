'use client'

import { useState } from 'react'
import { Loader2, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  type AppSettings,
  updateSettings,
} from '@/lib/api/settings'


export function SpeechSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved(settings: AppSettings): void
}) {
  const [provider, setProvider] = useState(
    settings?.speech_provider ?? 'mimo',
  )
  const [model, setModel] = useState(
    settings?.speech_model ?? 'mimo-v2.5-tts',
  )
  const [baseUrl, setBaseUrl] = useState(
    settings?.speech_base_url ?? 'https://api.xiaomimimo.com/v1',
  )
  const [defaultVoice, setDefaultVoice] = useState(
    settings?.speech_default_voice ?? 'mimo_default',
  )
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(clearKey = false) {
    setSaving(true)
    try {
      const updated = await updateSettings({
        speech_provider: provider,
        speech_model: model.trim(),
        speech_base_url: baseUrl.trim().replace(/\/+$/u, ''),
        speech_api_key: clearKey ? undefined : apiKey.trim() || undefined,
        speech_default_voice: defaultVoice.trim(),
        ...(clearKey ? { speech_clear_api_key: true } : {}),
      })
      onSaved(updated)
      setApiKey('')
      toast.success(clearKey ? '语音 API Key 已清除' : '语音合成配置已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormSection
      title="语音合成"
      description="当前首个适配器使用 MiMo V2.5 TTS。音色克隆不在本阶段范围内。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel>服务商</FieldLabel>
          <Select
            value={provider}
            onValueChange={value => {
              if (value) setProvider(value)
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="mimo">小米 MiMo</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="speech-model">模型</FieldLabel>
          <Input
            id="speech-model"
            value={model}
            onChange={event => setModel(event.target.value)}
            placeholder="mimo-v2.5-tts"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speech-base-url">Base URL</FieldLabel>
          <Input
            id="speech-base-url"
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
            placeholder="https://api.xiaomimimo.com/v1"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="speech-default-voice">默认音色</FieldLabel>
          <Input
            id="speech-default-voice"
            value={defaultVoice}
            onChange={event => setDefaultVoice(event.target.value)}
            placeholder="mimo_default"
          />
          <FieldDescription>
            项目没有单独指定音色时使用此值。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="speech-api-key">API Key</FieldLabel>
          <Input
            id="speech-api-key"
            type="password"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            placeholder={settings?.speech_api_key_set
              ? `已配置 (${settings.speech_api_key_preview})，留空保持不变`
              : '输入 MiMo API Key'}
            autoComplete="off"
          />
          <FieldDescription>
            {settings?.speech_api_key_set
              ? `已配置 (${settings.speech_api_key_preview})；浏览器不会读取已保存的密钥。`
              : '尚未配置；密钥保存后不会回显到浏览器。'}
          </FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void save()}
            disabled={
              saving
              || !model.trim()
              || !baseUrl.trim()
              || !defaultVoice.trim()
            }
          >
            {saving
              ? <Loader2 data-icon="inline-start" className="animate-spin" />
              : <Save data-icon="inline-start" />}
            保存语音配置
          </Button>
          {settings?.speech_api_key_set ? (
            <Button
              variant="ghost"
              onClick={() => void save(true)}
              disabled={saving}
            >
              <Trash2 data-icon="inline-start" />
              清除密钥
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </FormSection>
  )
}
