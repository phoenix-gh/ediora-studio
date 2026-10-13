// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DRAFT_ARTIFACT_EVENT,
  publishDraftArtifact,
  subscribeToDraftArtifacts,
} from './draft-artifacts'

describe('draft artifact events', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('publishes same-window and BroadcastChannel notifications and deduplicates them', () => {
    const postMessage = vi.fn()
    const close = vi.fn()
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null
      postMessage = postMessage
      close = close
    }
    vi.stubGlobal('BroadcastChannel', BroadcastChannelStub)
    const listener = vi.fn()
    const unsubscribe = subscribeToDraftArtifacts(listener)
    const artifact = { kind: 'draft' as const, id: 862, url: '/drafts?draft=862' }

    publishDraftArtifact(artifact)
    window.dispatchEvent(new CustomEvent(DRAFT_ARTIFACT_EVENT, { detail: artifact }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(artifact)
    expect(postMessage).toHaveBeenCalledWith(artifact)
    unsubscribe()
    expect(close).toHaveBeenCalled()
  })
})
