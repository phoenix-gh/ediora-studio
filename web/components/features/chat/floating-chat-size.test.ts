// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FLOATING_CHAT_SIZE,
  FLOATING_CHAT_SIZE_STORAGE_KEY,
  clampFloatingChatSize,
  readFloatingChatSize,
  writeFloatingChatSize,
} from './floating-chat-size'

const viewport = { width: 1280, height: 900 }

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

describe('floating chat size', () => {
  it('uses the default size and clamps to a narrow viewport', () => {
    expect(clampFloatingChatSize(DEFAULT_FLOATING_CHAT_SIZE, viewport)).toEqual({ width: 380, height: 560 })
    expect(clampFloatingChatSize({ width: 1000, height: 1000 }, { width: 360, height: 450 })).toEqual({
      width: 328,
      height: 418,
    })
  })

  it('falls back to a clamped default for invalid or out-of-range storage', () => {
    const storage = createStorage()
    storage.clear()

    storage.setItem(FLOATING_CHAT_SIZE_STORAGE_KEY, '{bad json')
    expect(readFloatingChatSize(storage, viewport)).toEqual(DEFAULT_FLOATING_CHAT_SIZE)

    storage.setItem(FLOATING_CHAT_SIZE_STORAGE_KEY, JSON.stringify({ width: '500', height: 640 }))
    expect(readFloatingChatSize(storage, viewport)).toEqual(DEFAULT_FLOATING_CHAT_SIZE)

    storage.setItem(FLOATING_CHAT_SIZE_STORAGE_KEY, JSON.stringify({ width: 1000, height: 1000 }))
    expect(readFloatingChatSize(storage, viewport)).toEqual(DEFAULT_FLOATING_CHAT_SIZE)
  })

  it('persists and restores a valid size', () => {
    const storage = createStorage()
    storage.clear()

    writeFloatingChatSize(storage, { width: 500, height: 640 })

    expect(storage.getItem(FLOATING_CHAT_SIZE_STORAGE_KEY)).toBe(JSON.stringify({ width: 500, height: 640 }))
    expect(readFloatingChatSize(storage, viewport)).toEqual({ width: 500, height: 640 })
  })
})
