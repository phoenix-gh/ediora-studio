import { afterEach, describe, expect, it, vi } from 'vitest'

import { configuredCodexTurn, loadConfiguredCodexTurn } from './codex-settings'

describe('configured Codex model', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads a saved model and ignores a blank or rejected id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      codex_model: 'proxy/custom-model',
      codex_reasoning_effort: 'high',
    }), { status: 200 })))
    await expect(loadConfiguredCodexTurn('http://api.test/api/')).resolves.toEqual({
      model: 'proxy/custom-model',
      reasoningEffort: 'high',
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      codex_model: 'deepseek-flash',
      codex_reasoning_effort: 'bad effort',
    }), { status: 200 })))
    await expect(loadConfiguredCodexTurn('http://api.test')).resolves.toEqual({})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(loadConfiguredCodexTurn('http://api.test')).resolves.toEqual({})
  })

  it('keeps the caller default when settings cannot be read', async () => {
    await expect(configuredCodexTurn({ apiRoot: () => 'http://api.test' })).resolves.toEqual({})
    await expect(configuredCodexTurn({
      apiRoot: () => 'http://api.test',
      codexTurn: async () => { throw new Error('offline') },
    })).resolves.toEqual({})
    await expect(configuredCodexTurn({
      apiRoot: () => 'http://api.test',
      codexTurn: async () => ({ model: 'gpt-5.4', reasoningEffort: 'xhigh' }),
    })).resolves.toEqual({ model: 'gpt-5.4', reasoningEffort: 'xhigh' })
  })
})
