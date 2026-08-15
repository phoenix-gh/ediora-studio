'use client'

import { useState } from 'react'
import { CheckCircle2, Eye, EyeOff, FlaskConical, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  type AppSettings,
  testComfyUI,
  updateSettings,
} from '@/lib/api/settings'


export function ComfyUISection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved: (settings: AppSettings) => void
}) {
  const [baseUrl, setBaseUrl] = useState(settings?.comfyui_base_url ?? '')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [minSeconds, setMinSeconds] = useState(
    String(settings?.comfyui_min_shot_seconds ?? 4),
  )
  const [maxSeconds, setMaxSeconds] = useState(
    String(settings?.comfyui_max_shot_seconds ?? 5),
  )
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    error: string
  } | null>(null)

  async function handleSave() {
    const minShotSeconds = Number(minSeconds)
    const maxShotSeconds = Number(maxSeconds)
    if (
      !Number.isInteger(minShotSeconds)
      || !Number.isInteger(maxShotSeconds)
      || minShotSeconds < 1
      || maxShotSeconds > 15
      || minShotSeconds > maxShotSeconds
    ) {
      toast.error('单镜时长需要在 1–15 秒之间，且下限不能大于上限')
      return
    }
    setSaving(true)
    try {
      const updated = await updateSettings({
        comfyui_base_url: baseUrl.trim(),
        comfyui_min_shot_seconds: minShotSeconds,
        comfyui_max_shot_seconds: maxShotSeconds,
        ...(token.trim() ? { comfyui_auth_token: token.trim() } : {}),
      })
      onSaved(updated)
      setToken('')
      setTestResult(null)
      toast.success('ComfyUI 配置已保存')
    } catch {
      toast.error('ComfyUI 配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const result = await testComfyUI()
      setTestResult(result)
      if (result.ok) toast.success('ComfyUI 连接正常')
    } catch (error) {
      setTestResult({
        ok: false,
        error: error instanceof Error ? error.message : '连接测试失败',
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <FormSection
      title="ComfyUI"
      description="用于 MiniMax H3 分镜口播。地址和鉴权只保存在服务端，浏览器不会拿到 token。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="comfyui-base-url">服务地址</FieldLabel>
          <Input
            id="comfyui-base-url"
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:8188"
            autoComplete="off"
          />
          <FieldDescription>
            测试连接会直连该地址，不走采集代理。本服务若在 WSL、ComfyUI 在 Windows，请填 Windows 主机 IP，不要填 127.0.0.1。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="comfyui-auth-token">鉴权 Token（可选）</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="comfyui-auth-token"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder={
                settings?.comfyui_auth_token_set
                  ? `已配置 (${settings.comfyui_auth_token_preview}) — 输入新值可替换`
                  : '未启用鉴权可留空'
              }
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={showToken ? '隐藏 Token' : '显示 Token'}
              onClick={() => setShowToken(value => !value)}
            >
              {showToken ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <FieldDescription>
            {settings?.comfyui_auth_token_set
              ? `已配置 (${settings.comfyui_auth_token_preview})`
              : '尚未配置 token'}
          </FieldDescription>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="comfyui-min-seconds">单镜下限（秒）</FieldLabel>
            <Input
              id="comfyui-min-seconds"
              type="number"
              min={1}
              max={15}
              value={minSeconds}
              onChange={event => setMinSeconds(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="comfyui-max-seconds">单镜上限（秒）</FieldLabel>
            <Input
              id="comfyui-max-seconds"
              type="number"
              min={1}
              max={15}
              value={maxSeconds}
              onChange={event => setMaxSeconds(event.target.value)}
            />
          </Field>
        </div>
        <FieldDescription>
          本机预算默认 5 秒。当前 H3 工作流下限通常是 4 秒。
        </FieldDescription>

        {testResult ? (
          <Alert variant={testResult.ok ? 'default' : 'destructive'}>
            <CheckCircle2 />
            <AlertTitle>
              {testResult.ok ? '连接成功' : '连接失败'}
            </AlertTitle>
            <AlertDescription>
              {testResult.ok
                ? '当前地址可以访问 ComfyUI。'
                : testResult.error}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            保存
          </Button>
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !settings?.comfyui_base_url}
          >
            {testing
              ? <Loader2 data-icon="inline-start" />
              : <FlaskConical data-icon="inline-start" />}
            测试连接
          </Button>
        </div>
      </FieldGroup>
    </FormSection>
  )
}
