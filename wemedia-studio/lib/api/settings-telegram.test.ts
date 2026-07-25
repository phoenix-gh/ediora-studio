import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearTelegramSettings,
  testTelegramSettings,
} from './settings'
import { makeSettings } from './settings-test-fixtures'

describe('Telegram settings API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('tests and clears only the saved Telegram configuration', async () => {
    const settingsFixture = makeSettings({
      telegram_bot_token_set: true,
      telegram_bot_token_preview: '…cret',
      telegram_chat_id: '-100123',
    })
    const fetchMock = vi.fn().mockImplementation(() => new Response(
      JSON.stringify(settingsFixture),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(testTelegramSettings()).resolves.toEqual(settingsFixture)
    await expect(clearTelegramSettings()).resolves.toEqual(settingsFixture)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8000/api/settings/telegram/test',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8000/api/settings/telegram',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body')
  })
})
