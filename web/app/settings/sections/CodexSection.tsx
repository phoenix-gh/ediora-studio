'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
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
import { NativeSelect } from '@/components/ui/native-select'
import {
  CHAT_MODEL_SELECTION_CHANGED_EVENT,
  ensureAssistantModel,
  FALLBACK_CHAT_MODELS,
  fetchChatModelCatalog,
  reasoningEffortLabel,
  writeStoredChatModelSelection,
  type ChatModelChoice,
  type ChatReasoningEffortOption,
} from '@/lib/ai/chat-model-catalog'
import {
  codexModelRejection,
  DEFAULT_CODEX_MODEL,
  usableCodexModel,
  usableCodexReasoningEffort,
} from '@/lib/ai/codex-model'
import { type AppSettings, updateSettings } from '@/lib/api/settings'

const CUSTOM_MODEL = '__custom__'

function savedModel(settings: AppSettings | null) {
  return usableCodexModel(settings?.codex_model) ?? DEFAULT_CODEX_MODEL
}

function savedEffort(settings: AppSettings | null) {
  return usableCodexReasoningEffort(settings?.codex_reasoning_effort) ?? 'medium'
}

function effortChoices(
  catalog: ChatModelChoice[],
  model: string,
  effort: string,
): ChatReasoningEffortOption[] {
  const known = catalog.find(item => item.model === model)
  const base = known?.supportedReasoningEfforts.length
    ? known.supportedReasoningEfforts
    : FALLBACK_CHAT_MODELS[0].supportedReasoningEfforts
  if (!known && effort && !base.some(item => item.reasoningEffort === effort)) {
    return [{ reasoningEffort: effort, description: '' }, ...base]
  }
  return base
}

function selectedEffort(
  catalog: ChatModelChoice[],
  model: string,
  effort: string,
  choices: ChatReasoningEffortOption[],
) {
  if (choices.some(item => item.reasoningEffort === effort)) return effort
  const known = catalog.find(item => item.model === model)
  return known?.defaultReasoningEffort
    || choices.find(item => item.reasoningEffort === 'medium')?.reasoningEffort
    || choices[0]?.reasoningEffort
    || 'medium'
}

function rememberChatModel(model: string, reasoningEffort: string) {
  try {
    writeStoredChatModelSelection(window.localStorage, { model, reasoningEffort })
    window.dispatchEvent(new Event(CHAT_MODEL_SELECTION_CHANGED_EVENT))
  } catch {
    // The server setting still applies when this browser has no chat override.
  }
}

export function CodexSection({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved: (settings: AppSettings) => void
}) {
  const persisted = savedModel(settings)
  const persistedEffort = savedEffort(settings)
  const [model, setModel] = useState(persisted)
  const [effort, setEffort] = useState(persistedEffort)
  const [catalog, setCatalog] = useState<ChatModelChoice[]>(FALLBACK_CHAT_MODELS)
  const [saving, setSaving] = useState(false)
  const known = catalog.some(item => item.model === model)
  const choices = effortChoices(catalog, model, effort)
  const effortValue = selectedEffort(catalog, model, effort, choices)

  useEffect(() => {
    setModel(persisted)
  }, [persisted])

  useEffect(() => {
    setEffort(persistedEffort)
  }, [persistedEffort])

  useEffect(() => {
    let cancelled = false
    void fetchChatModelCatalog().then(models => {
      if (!cancelled) setCatalog(ensureAssistantModel(models))
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave() {
    const next = model.trim()
    const rejection = codexModelRejection(next)
    if (rejection || !usableCodexModel(next)) {
      toast.error(rejection ?? '请填写模型')
      return
    }
    setSaving(true)
    try {
      const updated = await updateSettings({
        codex_model: next,
        codex_reasoning_effort: effortValue,
      })
      onSaved(updated)
      rememberChatModel(
        usableCodexModel(updated.codex_model) ?? next,
        usableCodexReasoningEffort(updated.codex_reasoning_effort) ?? effortValue,
      )
      toast.success('Codex 设置已保存')
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Codex 模型保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormSection
      title="Codex"
      description="助手和后续任务使用这里保存的模型和推理强度。可以从目录选择模型，也可以填入目录里没有的模型。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="codex-model-select">模型</FieldLabel>
          <NativeSelect
            id="codex-model-select"
            aria-label="模型"
            data-testid="codex-model-select"
            value={known ? model : CUSTOM_MODEL}
            onChange={event => {
              const value = event.target.value
              if (value === CUSTOM_MODEL) {
                if (known) setModel('')
                return
              }
              setModel(value)
            }}
          >
            {catalog.map(item => (
              <option key={item.id} value={item.model} title={item.description}>
                {item.displayName}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>自定义</option>
          </NativeSelect>
          <FieldDescription>
            选择目录中的模型后，下面的输入框会填入对应的模型 ID。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="codex-model-input">自定义模型</FieldLabel>
          <Input
            id="codex-model-input"
            aria-label="自定义模型"
            data-testid="codex-model-input"
            value={model}
            onChange={event => setModel(event.target.value)}
            placeholder={DEFAULT_CODEX_MODEL}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            例如 proxy/deepseek-v4-flash。斜线前面是提供方，后面是模型名。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="codex-reasoning-select">推理强度</FieldLabel>
          <NativeSelect
            id="codex-reasoning-select"
            aria-label="推理强度"
            data-testid="codex-reasoning-select"
            value={effortValue}
            onChange={event => setEffort(event.target.value)}
          >
            {choices.map(item => (
              <option key={item.reasoningEffort} value={item.reasoningEffort} title={item.description}>
                {reasoningEffortLabel(item.reasoningEffort)}
              </option>
            ))}
          </NativeSelect>
          <FieldDescription>
            强度越高，模型思考越久。目录中的模型只显示它支持的强度。
          </FieldDescription>
        </Field>
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          保存
        </Button>
      </FieldGroup>
    </FormSection>
  )
}
