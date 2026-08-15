'use client'

import { useEffect, useState } from 'react'
import { FlaskConical, Loader2, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group'
import {
  type AppSettings,
  getTranscriptionStatus,
  type TranscriptionProvider,
  type TranscriptionStatus,
  testTranscription,
  updateSettings,
} from '@/lib/api/settings'


const STATUS_COPY: Record<TranscriptionStatus['status'], string> = {
  unavailable: '本地转写服务未启动',
  preparing: '正在准备 large-v3 模型',
  ready: '本地转写服务可用',
  busy: '正在处理另一个转写任务',
  error: '本地转写服务异常',
}


export function TranscriptionSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved(settings: AppSettings): void
}) {
  const [provider, setProvider] = useState<TranscriptionProvider>(
    settings?.transcription_provider ?? 'local-whisper',
  )
  const [model, setModel] = useState(settings?.transcription_model ?? 'whisper-1')
  const [baseUrl, setBaseUrl] = useState(settings?.transcription_base_url ?? 'https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [maxMinutes, setMaxMinutes] = useState(Math.round((settings?.transcription_max_duration_seconds ?? 7200) / 60))
  const [status, setStatus] = useState<TranscriptionStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(provider === 'local-whisper')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (provider !== 'local-whisper') return
    let cancelled = false
    void getTranscriptionStatus()
      .then(result => {
        if (!cancelled) setStatus(result)
      })
      .catch(error => {
        if (!cancelled) {
          setStatus({
            provider: 'local-whisper',
            status: 'unavailable',
            model: 'Systran/faster-whisper-large-v3',
            device: 'cuda',
            compute_type: 'float16',
            error: error instanceof Error ? error.message : '无法读取服务状态',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [provider])

  async function save(clear = false) {
    setSaving(true)
    try {
      const updated = provider === 'local-whisper'
        ? await updateSettings({
            transcription_provider: provider,
            transcription_max_duration_seconds: Math.max(1, maxMinutes) * 60,
          })
        : await updateSettings({
            transcription_provider: provider,
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
      if (result.ok) {
        toast.success('转写服务连接正常')
        if (provider === 'local-whisper') {
          setStatus(await getTranscriptionStatus())
        }
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '连接测试失败')
    } finally {
      setTesting(false)
    }
  }

  const local = provider === 'local-whisper'
  const statusVariant = status?.status === 'ready'
    ? 'success'
    : status?.status === 'preparing' || status?.status === 'busy'
      ? 'warning'
      : 'destructive'

  return (
    <FormSection
      title="语音转写"
      description="文字视频使用逐词时间轴；YouTube 仅在没有中文或英文平台字幕时调用转写服务。"
    >
      <FieldGroup>
        <FieldSet>
          <FieldLegend>转写方式</FieldLegend>
          <RadioGroup
            value={provider}
            onValueChange={value => {
              if (value === 'local-whisper' || value === 'openai-compatible') {
                setProvider(value)
                setStatus(null)
                setStatusLoading(value === 'local-whisper')
              }
            }}
            className="grid gap-2 sm:grid-cols-2"
          >
            <FieldLabel>
              <RadioGroupItem value="local-whisper" />
              <Field>
                <span className="font-medium">本地 Whisper</span>
                <FieldDescription>使用本机 GPU，不产生云端转写费用。</FieldDescription>
              </Field>
            </FieldLabel>
            <FieldLabel>
              <RadioGroupItem value="openai-compatible" />
              <Field>
                <span className="font-medium">OpenAI 兼容服务</span>
                <FieldDescription>使用自定义 Base URL、模型和 API Key。</FieldDescription>
              </Field>
            </FieldLabel>
          </RadioGroup>
        </FieldSet>

        {local ? (
          <Alert variant={status?.status === 'error' || status?.status === 'unavailable' ? 'warning' : 'default'}>
            <AlertTitle className="flex items-center gap-2">
              {statusLoading ? '正在读取本地服务状态' : STATUS_COPY[status?.status ?? 'unavailable']}
              {!statusLoading && status ? (
                <Badge variant={statusVariant}>{status.status}</Badge>
              ) : null}
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>{status?.model ?? 'Systran/faster-whisper-large-v3'}</span>
              <span>
                {(status?.device ?? 'cuda')} · {(status?.compute_type ?? 'float16')}
              </span>
              {status?.error ? <span>{status.error}</span> : null}
            </AlertDescription>
          </Alert>
        ) : (
          <>
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
          </>
        )}

        <Field>
          <FieldLabel htmlFor="transcription-max-minutes">单视频最长分钟数</FieldLabel>
          <Input id="transcription-max-minutes" type="number" min={1} value={maxMinutes} onChange={event => setMaxMinutes(Number(event.target.value))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void save()}
            disabled={saving || (!local && (!baseUrl.trim() || !model.trim()))}
          >
            {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
            保存
          </Button>
          <Button
            variant="outline"
            onClick={() => void test()}
            disabled={testing || (!local && !settings?.transcription_api_key_set)}
          >
            {testing ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FlaskConical data-icon="inline-start" />}
            测试连接
          </Button>
          {!local && settings?.transcription_api_key_set ? (
            <Button variant="ghost" onClick={() => void save(true)} disabled={saving}>
              <Trash2 data-icon="inline-start" />
              清除密钥
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </FormSection>
  )
}
