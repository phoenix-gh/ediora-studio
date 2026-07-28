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
  testHeyGen,
  updateSettings,
} from '@/lib/api/settings'


export function HeyGenSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved: (settings: AppSettings) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    error: string
  } | null>(null)

  async function handleSave() {
    if (!apiKey.trim()) {
      toast.error('请输入新的 HeyGen API Key')
      return
    }
    setSaving(true)
    try {
      const updated = await updateSettings({ heygen_api_key: apiKey.trim() })
      onSaved(updated)
      setApiKey('')
      setTestResult(null)
      toast.success('HeyGen 配置已保存')
    } catch {
      toast.error('HeyGen 配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const result = await testHeyGen()
      setTestResult(result)
      if (result.ok) toast.success('HeyGen 连接正常')
    } catch (error) {
      setTestResult({
        ok: false,
        error: error instanceof Error ? error.message : '连接测试失败',
      })
    } finally {
      setTesting(false)
    }
  }

  const placeholder = settings?.heygen_api_key_set
    ? `已配置 (${settings.heygen_api_key_preview}) — 输入新值可替换`
    : '输入 HeyGen API Key'

  return (
    <FormSection
      title="HeyGen API"
      description="用于单照片数字人、声音克隆和 16:9 口播视频生成。密钥只保存在服务端。"
    >
      <FieldGroup>
          <Field>
            <FieldLabel htmlFor="heygen-api-key">API Key</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="heygen-api-key"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={placeholder}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowKey(value => !value)}
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <FieldDescription>
              {settings?.heygen_api_key_set
                ? `已配置 (${settings.heygen_api_key_preview})`
                : '尚未配置'}
            </FieldDescription>
          </Field>

          {testResult ? (
            <Alert variant={testResult.ok ? 'default' : 'destructive'}>
              <CheckCircle2 />
              <AlertTitle>
                {testResult.ok ? '连接成功' : '连接失败'}
              </AlertTitle>
              <AlertDescription>
                {testResult.ok
                  ? '当前 API Key 可以访问 HeyGen。'
                  : testResult.error}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !apiKey.trim()}>
              {saving ? <Loader2 data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              保存
            </Button>
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !settings?.heygen_api_key_set}
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
