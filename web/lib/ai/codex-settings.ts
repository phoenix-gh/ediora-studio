import { usableCodexModel, usableCodexReasoningEffort } from './codex-model'

export type CodexTurnSettings = {
  model?: string
  reasoningEffort?: string
}

function selection(model: unknown, reasoningEffort: unknown): CodexTurnSettings {
  const usableModel = usableCodexModel(model)
  const effort = usableCodexReasoningEffort(reasoningEffort)
  return {
    ...(usableModel ? { model: usableModel } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  }
}

export async function loadConfiguredCodexTurn(apiRoot: string): Promise<CodexTurnSettings> {
  const root = apiRoot.replace(/\/$/, '')
  const response = await fetch(`${root}/settings`, { cache: 'no-store' })
  if (!response.ok) return {}
  const body = await response.json() as {
    codex_model?: unknown
    codex_reasoning_effort?: unknown
  }
  return selection(body.codex_model, body.codex_reasoning_effort)
}

export async function configuredCodexTurn(deps: {
  apiRoot?: () => string
  codexTurn?: (apiRoot: string) => Promise<CodexTurnSettings>
}): Promise<CodexTurnSettings> {
  if (!deps.codexTurn || !deps.apiRoot) return {}
  try {
    const value = await deps.codexTurn(deps.apiRoot())
    return selection(value?.model, value?.reasoningEffort)
  } catch {
    return {}
  }
}
