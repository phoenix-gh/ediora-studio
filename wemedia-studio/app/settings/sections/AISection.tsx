'use client'

import { useId, useRef, useState } from 'react'
import { Loader2, Eye, EyeOff, RefreshCw, FlaskConical, CheckCircle, XCircle, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AppSettings, ProviderInfo, updateSettings, fetchProviderModels, testLLM } from '@/lib/api/settings'

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

export function AISection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const providers: ProviderInfo[] = settings?.providers ?? []

  const [provider, setProvider] = useState(settings?.llm_provider ?? 'openai')
  const [baseUrl, setBaseUrl]   = useState(
    settings?.llm_base_url ||
    providers.find(p => p.key === settings?.llm_provider)?.base_url || ''
  )
  const [apiKey, setApiKey]     = useState('')
  const [model, setModel]       = useState(settings?.llm_model ?? '')
  const [imageBaseUrl, setImageBaseUrl] = useState(settings?.image_base_url ?? '')
  const [imageApiKey, setImageApiKey] = useState('')
  const [imageModel, setImageModel] = useState(settings?.image_model ?? 'gpt-image-1')
  const [showKey, setShowKey]   = useState(false)
  const [saving, setSaving]     = useState(false)

  const [modelList, setModelList]         = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [showModelList, setShowModelList]  = useState(false)
  const [activeModelIndex, setActiveModelIndex] = useState(-1)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const modelListboxId = useId()
  const modelRequestSequence = useRef(0)

  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg]     = useState('')

  const currentPreset = providers.find(p => p.key === provider)

  function handleProviderChange(key: string) {
    modelRequestSequence.current += 1
    const preset = providers.find(p => p.key === key)
    setProvider(key)
    setBaseUrl(preset?.base_url ?? '')
    setModel('')
    setModelList([])
    setShowModelList(false)
    setActiveModelIndex(-1)
    setFetchingModels(false)
  }

  async function handleFetchModels() {
    const requestId = ++modelRequestSequence.current
    setFetchingModels(true)
    setShowModelList(false)
    setActiveModelIndex(-1)
    try {
      const res = await fetchProviderModels({
        provider,
        api_key: apiKey || undefined,
        base_url: baseUrl.trim() || undefined,
      })
      if (requestId !== modelRequestSequence.current) return
      if (res.ok && res.models.length) {
        setModelList(res.models)
        setShowModelList(true)
        toast.success(`获取到 ${res.models.length} 个可用模型`)
      } else {
        toast.error(res.error ?? '未返回模型列表')
      }
    } catch {
      if (requestId === modelRequestSequence.current) {
        toast.error('请求失败，请检查配置')
      }
    } finally {
      if (requestId === modelRequestSequence.current) {
        setFetchingModels(false)
      }
    }
  }

  async function handleTest() {
    setTestState('testing')
    setTestMsg('')
    try {
      const res = await testLLM()
      if (res.ok) {
        setTestState('ok')
        setTestMsg(res.response ?? '')
      } else {
        setTestState('fail')
        setTestMsg(res.error ?? '未知错误')
      }
    } catch (e) {
      setTestState('fail')
      setTestMsg(String(e))
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateSettings({
        llm_provider: provider,
        llm_model: model,
        llm_base_url: baseUrl,
        ...(apiKey ? { llm_api_key: apiKey } : {}),
        image_base_url: imageBaseUrl.trim(),
        image_model: imageModel.trim() || 'gpt-image-1',
        ...(imageApiKey ? { image_api_key: imageApiKey } : {}),
      })
      onSaved(updated)
      setApiKey('')
      setImageApiKey('')
      toast.success('AI 配置已保存')
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const filteredModels = model
    ? modelList.filter(m => m.toLowerCase().includes(model.toLowerCase()))
    : modelList

  const modelListOpen = showModelList && filteredModels.length > 0

  function closeModelList() {
    setShowModelList(false)
    setActiveModelIndex(-1)
  }

  function selectModel(item: string) {
    setModel(item)
    closeModelList()
  }

  function handleModelKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (modelListOpen) {
        event.preventDefault()
        closeModelList()
      }
      return
    }

    if (filteredModels.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setShowModelList(true)
      setActiveModelIndex(current => (
        current < filteredModels.length - 1 ? current + 1 : current
      ))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setShowModelList(true)
      setActiveModelIndex(current => (
        current === -1 ? filteredModels.length - 1 : Math.max(current - 1, 0)
      ))
      return
    }

    if (event.key === 'Enter' && modelListOpen && activeModelIndex >= 0) {
      event.preventDefault()
      selectModel(filteredModels[activeModelIndex])
    }
  }

  const keyPlaceholder = settings?.llm_api_key_set
    ? `已配置 (${settings.llm_api_key_preview}) — 留空不修改`
    : '输入 API Key'

  return (
    <div className="flex flex-col gap-4">
      <FormSection
        title="聊天模型"
        description="选择供应商并配置兼容接口。连通性测试始终使用已保存的配置。"
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="llm-provider">供应商</FieldLabel>
            <Select value={provider} onValueChange={value => value && handleProviderChange(value)}>
              <SelectTrigger id="llm-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {providers.map(item => (
                    <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="llm-api-key">API Key</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="llm-api-key"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={keyPlaceholder}
                className="font-mono"
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
            {settings?.llm_api_key_set && !apiKey ? (
              <FieldDescription className="flex items-center gap-1 text-foreground">
                <CheckCircle />
                已配置 ({settings.llm_api_key_preview})
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="llm-base-url">API Endpoint</FieldLabel>
            <Input
              id="llm-base-url"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder="https://..."
              className="font-mono"
            />
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-3">
              <FieldLabel htmlFor="llm-model">模型</FieldLabel>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleFetchModels}
                disabled={fetchingModels}
              >
                {fetchingModels
                  ? <Loader2 data-icon="inline-start" className="animate-spin" />
                  : <RefreshCw data-icon="inline-start" />}
                获取可用模型
              </Button>
            </div>
            <div className="relative">
              <Input
                id="llm-model"
                ref={modelInputRef}
                value={model}
                onChange={event => {
                  setModel(event.target.value)
                  setShowModelList(true)
                  setActiveModelIndex(-1)
                }}
                onFocus={() => modelList.length && setShowModelList(true)}
                onBlur={() => setTimeout(closeModelList, 150)}
                onKeyDown={handleModelKeyDown}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={modelListOpen}
                aria-controls={modelListOpen ? modelListboxId : undefined}
                aria-activedescendant={modelListOpen && activeModelIndex >= 0
                  ? `${modelListboxId}-option-${activeModelIndex}`
                  : undefined}
                placeholder={currentPreset?.default_model
                  ? `默认: ${currentPreset.default_model}`
                  : '输入或选择模型名称'}
                className="font-mono"
              />
              {modelListOpen ? (
                <div
                  id={modelListboxId}
                  role="listbox"
                  aria-label="可用模型"
                  className="absolute top-full z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
                >
                  {filteredModels.map((item, index) => (
                    <button
                      key={item}
                      id={`${modelListboxId}-option-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={activeModelIndex === index}
                      onMouseDown={event => {
                        event.preventDefault()
                        selectModel(item)
                      }}
                      className={cn(
                        'w-full rounded-md px-3 py-2 text-left text-sm font-mono transition-colors hover:bg-surface-muted',
                        (activeModelIndex === index || model === item) && 'bg-surface-muted text-foreground'
                      )}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <FieldDescription>留空使用供应商默认模型</FieldDescription>
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving
                ? <Loader2 data-icon="inline-start" className="animate-spin" />
                : <Save data-icon="inline-start" />}
              保存
            </Button>
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testState === 'testing' || !settings?.llm_api_key_set}
            >
              {testState === 'testing' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {testState === 'ok' ? <CheckCircle data-icon="inline-start" /> : null}
              {testState === 'fail' ? <XCircle data-icon="inline-start" /> : null}
              {testState === 'idle' ? <FlaskConical data-icon="inline-start" /> : null}
              连通性测试
            </Button>
            {testMsg ? (
              <span className={cn(
                'max-w-xs truncate text-sm',
                testState === 'fail' && 'text-destructive'
              )}>
                {testState === 'ok' ? `✓ ${testMsg}` : testMsg}
              </span>
            ) : null}
          </div>
        </FieldGroup>
      </FormSection>

      <FormSection
        title="图像生成"
        description="封面和插图使用此独立配置，不会复用聊天模型接口。需使用支持 OpenAI Images API 的服务。"
        actions={(
          <Button type="button" variant="outline" size="sm" onClick={handleSave} disabled={saving}>
            {saving
              ? <Loader2 data-icon="inline-start" className="animate-spin" />
              : <Save data-icon="inline-start" />}
            保存图像配置
          </Button>
        )}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="image-base-url">图像生成 Endpoint</FieldLabel>
            <Input
              id="image-base-url"
              value={imageBaseUrl}
              onChange={event => setImageBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className="font-mono"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="image-api-key">图像生成 API Key</FieldLabel>
            <Input
              id="image-api-key"
              type={showKey ? 'text' : 'password'}
              value={imageApiKey}
              onChange={event => setImageApiKey(event.target.value)}
              placeholder={settings?.image_api_key_set
                ? `已配置 (${settings.image_api_key_preview}) — 留空不修改`
                : '输入图像模型 API Key'}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="image-model">图像模型</FieldLabel>
            <Input
              id="image-model"
              value={imageModel}
              onChange={event => setImageModel(event.target.value)}
              placeholder="gpt-image-1"
              className="font-mono"
            />
          </Field>
        </FieldGroup>
      </FormSection>
    </div>
  )
}
