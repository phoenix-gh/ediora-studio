'use client'

import { useState, useRef } from 'react'
import { Loader2, Eye, EyeOff, RefreshCw, FlaskConical, CheckCircle, XCircle, Save } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  const modelInputRef = useRef<HTMLInputElement>(null)

  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg]     = useState('')

  const currentPreset = providers.find(p => p.key === provider)

  function handleProviderChange(key: string) {
    const preset = providers.find(p => p.key === key)
    setProvider(key)
    setBaseUrl(preset?.base_url ?? '')
    setModel('')
    setModelList([])
  }

  async function handleFetchModels() {
    setFetchingModels(true)
    setShowModelList(false)
    try {
      const res = await fetchProviderModels({
        provider,
        api_key: apiKey || undefined,
        base_url: baseUrl.trim() || undefined,
      })
      if (res.ok && res.models.length) {
        setModelList(res.models)
        setShowModelList(true)
        toast.success(`获取到 ${res.models.length} 个可用模型`)
      } else {
        toast.error(res.error ?? '未返回模型列表')
      }
    } catch {
      toast.error('请求失败，请检查配置')
    } finally {
      setFetchingModels(false)
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

  const keyPlaceholder = settings?.llm_api_key_set
    ? `已配置 (${settings.llm_api_key_preview}) — 留空不修改`
    : '输入 API Key'
  return (
    <div className="space-y-5">
      {/* Provider */}
      <div className="space-y-1.5">
        <Label className="text-xs">供应商</Label>
        <Select value={provider} onValueChange={v => v && handleProviderChange(v)}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map(p => (
              <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <Label className="text-xs">API Key</Label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={keyPlaceholder}
            className="h-9 text-sm pr-9 font-mono"
            autoComplete="off"
          />
          <button type="button" onClick={() => setShowKey(v => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        {settings?.llm_api_key_set && !apiKey && (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />已配置 ({settings.llm_api_key_preview})
          </p>
        )}
      </div>

      {/* Endpoint */}
      <div className="space-y-1.5">
        <Label className="text-xs">API Endpoint</Label>
        <Input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://..."
          className="h-9 text-sm font-mono"
        />
      </div>

      {/* Model combobox */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">模型</Label>
          <button onClick={handleFetchModels} disabled={fetchingModels}
            className="flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-600 disabled:opacity-50 transition-colors">
            {fetchingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            获取可用模型
          </button>
        </div>
        <div className="relative">
          <Input
            ref={modelInputRef}
            value={model}
            onChange={e => { setModel(e.target.value); setShowModelList(true) }}
            onFocus={() => modelList.length && setShowModelList(true)}
            onBlur={() => setTimeout(() => setShowModelList(false), 150)}
            placeholder={currentPreset?.default_model ? `默认: ${currentPreset.default_model}` : '输入或选择模型名称'}
            className="h-9 text-sm font-mono"
          />
          {showModelList && filteredModels.length > 0 && (
            <div className="absolute z-20 top-full mt-1 w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg max-h-52 overflow-y-auto">
              {filteredModels.map(m => (
                <button key={m} onMouseDown={() => { setModel(m); setShowModelList(false) }}
                  className={cn(
                    'w-full text-left px-3 py-2 text-xs font-mono hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
                    model === m && 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400'
                  )}>
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="text-[11px] text-zinc-400">留空使用供应商默认模型</p>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 space-y-3">
        <div>
          <Label className="text-xs">图像生成 Endpoint</Label>
          <Input value={imageBaseUrl} onChange={e => setImageBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="h-9 text-sm font-mono mt-1.5" />
        </div>
        <div>
          <Label className="text-xs">图像生成 API Key</Label>
          <Input type={showKey ? 'text' : 'password'} value={imageApiKey} onChange={e => setImageApiKey(e.target.value)} placeholder={settings?.image_api_key_set ? `已配置 (${settings.image_api_key_preview}) — 留空不修改` : '输入图像模型 API Key'} className="h-9 text-sm font-mono mt-1.5" autoComplete="off" />
        </div>
        <div>
          <Label className="text-xs">图像模型</Label>
          <Input value={imageModel} onChange={e => setImageModel(e.target.value)} placeholder="gpt-image-1" className="h-9 text-sm font-mono mt-1.5" />
        </div>
        <p className="text-[11px] text-zinc-400">封面和插图使用此配置，不会复用聊天模型接口。需使用支持 OpenAI Images API 的服务。</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          保存
        </Button>
        <Button variant="outline" size="sm" onClick={handleTest}
          disabled={testState === 'testing' || !settings?.llm_api_key_set} className="gap-1.5">
          {testState === 'testing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {testState === 'ok'      && <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />}
          {testState === 'fail'    && <XCircle className="w-3.5 h-3.5 text-red-500" />}
          {testState === 'idle'    && <FlaskConical className="w-3.5 h-3.5" />}
          连通性测试
        </Button>
        {testMsg && (
          <span className={cn('text-xs truncate max-w-xs',
            testState === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
            {testState === 'ok' ? `✓ ${testMsg}` : testMsg}
          </span>
        )}
      </div>
    </div>
  )
}
