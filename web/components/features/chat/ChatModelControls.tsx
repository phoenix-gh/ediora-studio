'use client'

import { useEffect, useRef, useState } from 'react'

import { NativeSelect } from '@/components/ui/native-select'
import {
  CHAT_MODEL_SELECTION_CHANGED_EVENT,
  ensureNamedModel,
  FALLBACK_CHAT_MODELS,
  fetchChatModelCatalog,
  readStoredChatModelSelection,
  reasoningEffortLabel,
  resolveChatModelSelection,
  writeStoredChatModelSelection,
  type ChatModelChoice,
  type ChatModelSelection,
} from '@/lib/ai/chat-model-catalog'
import { DEFAULT_CODEX_MODEL, usableCodexModel, usableCodexReasoningEffort } from '@/lib/ai/codex-model'
import { getSettings } from '@/lib/api/settings'

function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useChatModelSelection() {
  const [models, setModels] = useState<ChatModelChoice[]>(FALLBACK_CHAT_MODELS)
  const [selection, setSelection] = useState<ChatModelSelection>(() => (
    resolveChatModelSelection(FALLBACK_CHAT_MODELS, null)
  ))
  const readyRef = useRef(false)
  const modelsRef = useRef(models)
  modelsRef.current = models

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetchChatModelCatalog(),
      getSettings().then(settings => ({
        model: settings.codex_model,
        reasoningEffort: settings.codex_reasoning_effort,
      })).catch(() => ({ model: '', reasoningEffort: '' })),
    ]).then(([catalog, configuredRaw]) => {
      if (cancelled) return
      const stored = readStoredChatModelSelection(browserStorage())
      const configured = usableCodexModel(configuredRaw.model) ?? DEFAULT_CODEX_MODEL
      const configuredEffort = usableCodexReasoningEffort(configuredRaw.reasoningEffort) ?? 'medium'
      const preferred = {
        model: stored?.model || configured,
        reasoningEffort: stored?.reasoningEffort || configuredEffort,
      }
      let available = ensureNamedModel(catalog, configured, configuredEffort)
      if (preferred.model !== configured) {
        available = ensureNamedModel(available, preferred.model, preferred.reasoningEffort)
      }
      readyRef.current = true
      setModels(available)
      setSelection(resolveChatModelSelection(available, preferred))
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const applySavedModel = () => {
      const stored = readStoredChatModelSelection(browserStorage())
      const model = usableCodexModel(stored?.model)
      if (!model) return
      const available = ensureNamedModel(modelsRef.current, model, stored?.reasoningEffort)
      readyRef.current = true
      setModels(available)
      setSelection(resolveChatModelSelection(available, {
        model,
        reasoningEffort: stored?.reasoningEffort,
      }))
    }
    window.addEventListener(CHAT_MODEL_SELECTION_CHANGED_EVENT, applySavedModel)
    return () => window.removeEventListener(CHAT_MODEL_SELECTION_CHANGED_EVENT, applySavedModel)
  }, [])

  useEffect(() => {
    if (!readyRef.current) return
    writeStoredChatModelSelection(browserStorage(), selection)
  }, [selection])

  return {
    models,
    selection,
    setModel(model: string) {
      setSelection(current => resolveChatModelSelection(models, {
        model,
        reasoningEffort: current.reasoningEffort,
      }))
    },
    setReasoningEffort(reasoningEffort: string) {
      setSelection(current => resolveChatModelSelection(models, {
        model: current.model,
        reasoningEffort,
      }))
    },
  }
}

export function ChatModelControls({
  models,
  selection,
  disabled,
  onModelChange,
  onReasoningEffortChange,
}: {
  models: ChatModelChoice[]
  selection: ChatModelSelection
  disabled: boolean
  onModelChange: (model: string) => void
  onReasoningEffortChange: (reasoningEffort: string) => void
}) {
  const selected = models.find(model => model.model === selection.model) ?? models[0]
  const efforts = selected?.supportedReasoningEfforts ?? []

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <NativeSelect
        aria-label="模型"
        data-testid="chat-model-select"
        value={selection.model}
        disabled={disabled || models.length === 0}
        className="h-7 w-auto max-w-44 px-2 text-xs"
        onChange={event => onModelChange(event.target.value)}
      >
        {models.map(model => (
          <option key={model.id} value={model.model} title={model.description}>
            {model.displayName}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="思考强度"
        data-testid="chat-reasoning-select"
        value={selection.reasoningEffort}
        disabled={disabled || efforts.length === 0}
        className="h-7 w-auto max-w-32 px-2 text-xs"
        onChange={event => onReasoningEffortChange(event.target.value)}
      >
        {efforts.map(effort => (
          <option key={effort.reasoningEffort} value={effort.reasoningEffort} title={effort.description}>
            {reasoningEffortLabel(effort.reasoningEffort)}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}
