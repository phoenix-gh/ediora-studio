'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { CheckCircle, Eye, EyeOff, FlaskConical, Loader2, Pencil, Plus, RefreshCw, Save, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FormSection } from '@/components/layout/FormSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AppSettings,
  LLMAdapter,
  LLMAdapterInput,
  ProviderInfo,
  updateSettings,
  fetchProviderModels,
  testLLM,
  testLLMAdapter,
} from '@/lib/api/settings'
import {
  LLMAdapterEditor,
  type LLMAdapterDraft,
  type LLMAdapterTestState,
} from './LLMAdapterEditor'

type TestState = LLMAdapterTestState

type AdapterTestResult = {
  state: TestState
  message: string
}

function draftFromAdapter(adapter: LLMAdapter): LLMAdapterDraft {
  return { ...adapter, api_key: '', clear_api_key: false }
}

function newAdapterId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `adapter-${Date.now()}`
}

function adapterInputFromDraft(adapter: LLMAdapterDraft): LLMAdapterInput {
  return {
    id: adapter.id,
    name: adapter.name,
    protocol: adapter.protocol,
    endpoint: adapter.endpoint,
    model: adapter.model,
    supports_text: adapter.supports_text,
    supports_image: adapter.supports_image,
    image_response_format: adapter.image_response_format,
    ...(adapter.api_key ? { api_key: adapter.api_key } : {}),
    ...(adapter.clear_api_key ? { clear_api_key: true } : {}),
  }
}

export function AISection({ settings, onSaved }: { settings: AppSettings | null; onSaved: (s: AppSettings) => void }) {
  const providers: ProviderInfo[] = settings?.providers ?? []
  const [adapters, setAdapters] = useState<LLMAdapterDraft[]>(
    () => (settings?.llm_adapters ?? []).map(draftFromAdapter),
  )
  const [textDefaultAdapterId, setTextDefaultAdapterId] = useState(
    settings?.llm_text_default_adapter_id ?? '',
  )
  const [imageDefaultAdapterId, setImageDefaultAdapterId] = useState(
    settings?.llm_image_default_adapter_id ?? '',
  )
  const [informationFilteringAdapterId, setInformationFilteringAdapterId] = useState(
    settings?.llm_information_filtering_adapter_id ?? '',
  )

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
  const [promptHistoryLimit, setPromptHistoryLimit] = useState(
    settings?.prompt_generation_history_limit ?? 3,
  )
  const [showKey, setShowKey]   = useState(false)
  const [saving, setSaving]     = useState(false)

  const [modelList, setModelList]         = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [showModelList, setShowModelList]  = useState(false)
  const [activeModelIndex, setActiveModelIndex] = useState(-1)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const modelListboxId = useId()
  const modelRequestSequence = useRef(0)
  const modelBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg]     = useState('')
  const [adapterTests, setAdapterTests] = useState<Record<string, AdapterTestResult>>({})
  const [adapterEditorOpen, setAdapterEditorOpen] = useState(false)
  const [adapterEditorDraft, setAdapterEditorDraft] = useState<LLMAdapterDraft | null>(null)
  const [editingAdapterId, setEditingAdapterId] = useState<string | null>(null)

  const currentPreset = providers.find(p => p.key === provider)

  useEffect(() => () => {
    if (modelBlurTimer.current !== null) {
      clearTimeout(modelBlurTimer.current)
    }
  }, [])

  function handleProviderChange(key: string) {
    modelRequestSequence.current += 1
    const preset = providers.find(p => p.key === key)
    setProvider(key)
    setBaseUrl(preset?.base_url ?? '')
    setModel('')
    setModelList([])
    closeModelList()
    setFetchingModels(false)
  }

  async function handleFetchModels() {
    const requestId = ++modelRequestSequence.current
    setFetchingModels(true)
    closeModelList()
    try {
      const res = await fetchProviderModels({
        provider,
        api_key: apiKey || undefined,
        base_url: baseUrl.trim() || undefined,
      })
      if (requestId !== modelRequestSequence.current) return
      if (res.ok && res.models.length) {
        setModelList(res.models)
        openModelList()
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
        prompt_generation_history_limit: Number(promptHistoryLimit),
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

  async function handleTestAdapter(adapter: LLMAdapterDraft) {
    setAdapterTests(current => ({
      ...current,
      [adapter.id]: { state: 'testing', message: '' },
    }))
    try {
      const res = await testLLMAdapter({ adapter: adapterInputFromDraft(adapter) })
      setAdapterTests(current => ({
        ...current,
        [adapter.id]: {
          state: res.ok ? 'ok' : 'fail',
          message: res.ok ? (res.response ?? '连接成功') : (res.error ?? '未知错误'),
        },
      }))
    } catch (error) {
      setAdapterTests(current => ({
        ...current,
        [adapter.id]: { state: 'fail', message: String(error) },
      }))
    }
  }

  function createAdapterDraft(): LLMAdapterDraft {
    return {
      id: newAdapterId(),
      name: '',
      protocol: 'openai',
      endpoint: 'https://api.openai.com/v1',
      model: '',
      supports_text: true,
      supports_image: false,
      image_response_format: 'base64',
      api_key_set: false,
      api_key_preview: '',
      api_key: '',
      clear_api_key: false,
    }
  }

  function resetAdapterTest(id: string) {
    setAdapterTests(current => current[id]
      ? { ...current, [id]: { state: 'idle', message: '' } }
      : current)
  }

  function openAdapterEditor(adapter: LLMAdapterDraft) {
    setEditingAdapterId(adapter.id)
    setAdapterEditorDraft({ ...adapter })
    resetAdapterTest(adapter.id)
    setAdapterEditorOpen(true)
  }

  function openNewAdapterEditor() {
    const draft = createAdapterDraft()
    setEditingAdapterId(null)
    setAdapterEditorDraft(draft)
    setAdapterTests(current => {
      const next = { ...current }
      delete next[draft.id]
      return next
    })
    setAdapterEditorOpen(true)
  }

  function closeAdapterEditor() {
    setAdapterEditorOpen(false)
    setAdapterEditorDraft(null)
    setEditingAdapterId(null)
  }

  function updateAdapterDraft(patch: Partial<LLMAdapterDraft>) {
    if (!adapterEditorDraft) return
    setAdapterEditorDraft(current => current ? { ...current, ...patch } : current)
    resetAdapterTest(adapterEditorDraft.id)
  }

  function saveAdapterDraft() {
    if (!adapterEditorDraft) return
    const draft = { ...adapterEditorDraft }
    setAdapters(current => editingAdapterId
      ? current.map(adapter => adapter.id === editingAdapterId ? draft : adapter)
      : [...current, draft])
    closeAdapterEditor()
  }

  function addAdapter() {
    openNewAdapterEditor()
  }

  function removeAdapter(id: string) {
    setAdapters(current => current.filter(adapter => adapter.id !== id))
    if (textDefaultAdapterId === id) setTextDefaultAdapterId('')
    if (imageDefaultAdapterId === id) setImageDefaultAdapterId('')
    if (informationFilteringAdapterId === id) setInformationFilteringAdapterId('')
    setAdapterTests(current => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  function deleteAdapterFromEditor() {
    if (editingAdapterId) {
      removeAdapter(editingAdapterId)
    }
    closeAdapterEditor()
  }

  async function handleSaveAdapters() {
    setSaving(true)
    try {
      const llm_adapters: LLMAdapterInput[] = adapters.map(adapterInputFromDraft)
      const updated = await updateSettings({
        llm_adapters,
        llm_text_default_adapter_id: textDefaultAdapterId,
        llm_image_default_adapter_id: imageDefaultAdapterId,
        llm_information_filtering_adapter_id: informationFilteringAdapterId,
        prompt_generation_history_limit: Number(promptHistoryLimit),
      })
      setAdapters((updated.llm_adapters ?? []).map(draftFromAdapter))
      setTextDefaultAdapterId(updated.llm_text_default_adapter_id ?? '')
      setImageDefaultAdapterId(updated.llm_image_default_adapter_id ?? '')
      setInformationFilteringAdapterId(updated.llm_information_filtering_adapter_id ?? '')
      setAdapterTests({})
      onSaved(updated)
      toast.success('AI Adapter 配置已保存')
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

  function cancelModelBlurTimer() {
    if (modelBlurTimer.current === null) return
    clearTimeout(modelBlurTimer.current)
    modelBlurTimer.current = null
  }

  function openModelList() {
    cancelModelBlurTimer()
    setShowModelList(true)
  }

  function closeModelList() {
    cancelModelBlurTimer()
    setShowModelList(false)
    setActiveModelIndex(-1)
  }

  function scheduleModelListClose() {
    cancelModelBlurTimer()
    modelBlurTimer.current = setTimeout(() => {
      modelBlurTimer.current = null
      closeModelList()
    }, 150)
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
      openModelList()
      setActiveModelIndex(current => (
        current < filteredModels.length - 1 ? current + 1 : current
      ))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      openModelList()
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
        title="LLM Adapter 实例"
        description="可以配置多个 OpenAI-compatible 接口，分别指定文字默认、图片默认和信息筛选 Adapter。"
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {adapters.map(adapter => {
              const roleLabels: string[] = []
              if (textDefaultAdapterId === adapter.id) roleLabels.push('文字默认')
              if (imageDefaultAdapterId === adapter.id) roleLabels.push('图片默认')
              if (informationFilteringAdapterId === adapter.id) roleLabels.push('信息筛选')

              return (
                <Card key={adapter.id} size="sm" data-testid={`llm-adapter-card-${adapter.id}`}>
                  <CardHeader className="flex flex-row items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate">{adapter.name || '未命名 Adapter'}</CardTitle>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {adapter.model || '未设置模型'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`编辑 Adapter ${adapter.name || adapter.id}`}
                      onClick={() => openAdapterEditor(adapter)}
                    >
                      <Pencil />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">OpenAI-compatible</Badge>
                      {adapter.supports_text ? <Badge variant="info">文本</Badge> : null}
                      {adapter.supports_image ? <Badge variant="ai">图片</Badge> : null}
                      {adapter.supports_image ? (
                        <Badge variant="outline">
                          图片 {adapter.image_response_format === 'url' ? 'URL' : 'base64'}
                        </Badge>
                      ) : null}
                      {!adapter.supports_text && !adapter.supports_image ? (
                        <Badge variant="warning">未设置能力</Badge>
                      ) : null}
                    </div>
                    {roleLabels.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 border-t border-border/70 pt-2">
                        {roleLabels.map(label => <Badge key={label} variant="ai">{label}</Badge>)}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              )
            })}
            <Card size="sm" data-testid="llm-adapter-add-card" className="border-dashed bg-transparent">
              <CardContent className="flex min-h-32 items-center justify-center">
                <Button type="button" variant="ghost" onClick={addAdapter}>
                  <Plus data-icon="inline-start" />
                  添加 Adapter
                </Button>
              </CardContent>
            </Card>
          </div>

          {adapters.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              尚未配置新 Adapter。添加后，文本、信息筛选和图片任务会按 Adapter 能力选择；旧配置仍可继续使用。
            </p>
          ) : (
            <div className="rounded-lg border border-border/70 bg-surface-muted/20 p-3">
              <div>
                <p className="text-xs font-semibold text-foreground">用途分配</p>
                <p className="mt-1 text-xs text-muted-foreground">分别指定文字、图片和信息筛选使用的 Adapter。</p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="space-y-1.5 text-xs font-medium" htmlFor="text-default-llm-adapter">
                  文字默认 Adapter
                  <NativeSelect
                    id="text-default-llm-adapter"
                    aria-label="文字默认 Adapter"
                    value={textDefaultAdapterId}
                    onChange={event => setTextDefaultAdapterId(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {adapters.filter(adapter => adapter.supports_text).map(adapter => (
                      <option key={adapter.id} value={adapter.id}>{adapter.name || adapter.id}</option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="space-y-1.5 text-xs font-medium" htmlFor="image-default-llm-adapter">
                  图片默认 Adapter
                  <NativeSelect
                    id="image-default-llm-adapter"
                    aria-label="图片默认 Adapter"
                    value={imageDefaultAdapterId}
                    onChange={event => setImageDefaultAdapterId(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {adapters.filter(adapter => adapter.supports_image).map(adapter => (
                      <option key={adapter.id} value={adapter.id}>{adapter.name || adapter.id}</option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="space-y-1.5 text-xs font-medium" htmlFor="information-filtering-adapter">
                  信息筛选 Adapter
                  <NativeSelect
                    id="information-filtering-adapter"
                    aria-label="信息筛选 Adapter"
                    value={informationFilteringAdapterId}
                    onChange={event => setInformationFilteringAdapterId(event.target.value)}
                  >
                    <option value="">跟随文字默认</option>
                    {adapters.filter(adapter => adapter.supports_text).map(adapter => (
                      <option key={adapter.id} value={adapter.id}>{adapter.name || adapter.id}</option>
                    ))}
                  </NativeSelect>
                </label>
              </div>
            </div>
          )}

          {adapters.length > 0 ? (
            <div className="flex justify-end border-t border-border/70 pt-3">
              <Button type="button" onClick={handleSaveAdapters} disabled={saving}>
                {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
                保存 AI 配置
              </Button>
            </div>
          ) : null}
        </div>
      </FormSection>

      <Dialog
        open={adapterEditorOpen}
        onOpenChange={open => {
          if (!open) closeAdapterEditor()
        }}
      >
        {adapterEditorDraft ? (
          <DialogContent size="lg" className="max-h-[90vh]">
            <DialogHeader>
              <DialogTitle>{editingAdapterId ? '编辑 Adapter' : '添加 Adapter'}</DialogTitle>
              <DialogDescription>配置接口、模型、密钥和支持的能力；连接测试使用当前编辑中的值。</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto pr-1">
              <LLMAdapterEditor
                adapter={adapterEditorDraft}
                onChange={updateAdapterDraft}
                onDelete={editingAdapterId ? deleteAdapterFromEditor : undefined}
                onTest={() => handleTestAdapter(adapterEditorDraft)}
                testState={adapterTests[adapterEditorDraft.id]?.state ?? 'idle'}
                testMessage={adapterTests[adapterEditorDraft.id]?.message ?? ''}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeAdapterEditor}>取消</Button>
              <Button type="button" onClick={saveAdapterDraft}>保存 Adapter</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      {adapters.length === 0 ? <>
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
                  openModelList()
                  setActiveModelIndex(-1)
                }}
                onFocus={() => modelList.length && openModelList()}
                onBlur={scheduleModelListClose}
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
          <Field>
            <FieldLabel htmlFor="prompt-generation-history">提示词生成历史</FieldLabel>
            <Input
              id="prompt-generation-history"
              type="number"
              min={1}
              max={20}
              value={promptHistoryLimit}
              onChange={event => setPromptHistoryLimit(Number(event.target.value))}
            />
            <FieldDescription>默认保留最近 3 条成功结果，范围为 1–20 条。</FieldDescription>
          </Field>
        </FieldGroup>
      </FormSection>
      </> : null}
    </div>
  )
}
