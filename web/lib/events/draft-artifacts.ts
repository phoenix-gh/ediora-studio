import type { PersistedArtifact } from '@/lib/ai/chat-run-types'

export const DRAFT_ARTIFACT_EVENT = 'ediora:draft-artifact-created'
const DRAFT_ARTIFACT_CHANNEL = 'ediora:draft-artifacts'

function artifactKey(artifact: PersistedArtifact) {
  return `${artifact.kind}:${artifact.id}`
}

function isDraftArtifact(value: unknown): value is PersistedArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as Record<string, unknown>
  return artifact.kind === 'draft' && typeof artifact.id === 'number' && typeof artifact.url === 'string'
}

export function publishDraftArtifact(artifact: PersistedArtifact): void {
  if (artifact.kind !== 'draft' || typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(DRAFT_ARTIFACT_EVENT, { detail: artifact }))
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(DRAFT_ARTIFACT_CHANNEL)
  channel.postMessage(artifact)
  channel.close()
}

export function subscribeToDraftArtifacts(
  listener: (artifact: PersistedArtifact) => void,
): () => void {
  const seen = new Set<string>()
  const deliver = (value: unknown) => {
    if (!isDraftArtifact(value)) return
    const key = artifactKey(value)
    if (seen.has(key)) return
    seen.add(key)
    listener(value)
  }
  const sameWindow = (event: Event) => deliver((event as CustomEvent).detail)
  window.addEventListener(DRAFT_ARTIFACT_EVENT, sameWindow)
  const channel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(DRAFT_ARTIFACT_CHANNEL)
  if (channel) channel.onmessage = event => deliver(event.data)
  return () => {
    window.removeEventListener(DRAFT_ARTIFACT_EVENT, sameWindow)
    channel?.close()
  }
}
