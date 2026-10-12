import { NextResponse } from 'next/server'

import {
  ensureAssistantModel,
  FALLBACK_CHAT_MODELS,
  parseChatModelCatalog,
  type ChatModelChoice,
} from '@/lib/ai/chat-model-catalog'
import { listCodexModels } from '@/lib/ai/codex-app-server-client'

const CACHE_MS = 60_000

let cache: { at: number, models: ChatModelChoice[] } | undefined

export function resetChatModelCatalogCache() {
  cache = undefined
}

export async function GET() {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) {
    return NextResponse.json({ models: cache.models })
  }
  try {
    const models = parseChatModelCatalog(await listCodexModels())
    const resolved = ensureAssistantModel(models)
    cache = { at: now, models: resolved }
    return NextResponse.json({ models: resolved })
  } catch {
    return NextResponse.json({ models: FALLBACK_CHAT_MODELS })
  }
}
