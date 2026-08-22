export const DEFAULT_FLOATING_CHAT_SIZE = { width: 380, height: 560 } as const
export const FLOATING_CHAT_SIZE_STORAGE_KEY = 'ediora.global-chat.panel-size.v1'

export type FloatingChatSize = {
  width: number
  height: number
}

type Viewport = {
  width: number
  height: number
}

const MIN_WIDTH = 320
const MIN_HEIGHT = 420
const MAX_WIDTH = 720
const MAX_HEIGHT = 780

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function bounds(viewport: Viewport) {
  const viewportWidth = finitePositive(viewport.width, DEFAULT_FLOATING_CHAT_SIZE.width + 32)
  const viewportHeight = finitePositive(viewport.height, DEFAULT_FLOATING_CHAT_SIZE.height + 32)
  const maxWidth = Math.min(MAX_WIDTH, Math.max(0, viewportWidth - 32))
  const maxHeight = Math.min(MAX_HEIGHT, Math.max(0, viewportHeight - 32))
  return {
    minWidth: Math.min(MIN_WIDTH, maxWidth),
    maxWidth,
    minHeight: Math.min(MIN_HEIGHT, maxHeight),
    maxHeight,
  }
}

export function clampFloatingChatSize(size: FloatingChatSize, viewport: Viewport): FloatingChatSize {
  const limits = bounds(viewport)
  const width = Number.isFinite(size.width) ? size.width : DEFAULT_FLOATING_CHAT_SIZE.width
  const height = Number.isFinite(size.height) ? size.height : DEFAULT_FLOATING_CHAT_SIZE.height
  return {
    width: Math.min(limits.maxWidth, Math.max(limits.minWidth, width)),
    height: Math.min(limits.maxHeight, Math.max(limits.minHeight, height)),
  }
}

function isSize(value: unknown): value is FloatingChatSize {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.width === 'number'
    && Number.isFinite(candidate.width)
    && typeof candidate.height === 'number'
    && Number.isFinite(candidate.height)
}

export function readFloatingChatSize(storage: Storage | null, viewport: Viewport): FloatingChatSize {
  const defaultSize = clampFloatingChatSize(DEFAULT_FLOATING_CHAT_SIZE, viewport)
  if (!storage) return defaultSize

  try {
    const raw = storage.getItem(FLOATING_CHAT_SIZE_STORAGE_KEY)
    if (!raw) return defaultSize
    const parsed: unknown = JSON.parse(raw)
    if (!isSize(parsed)) return defaultSize
    const limits = bounds(viewport)
    if (parsed.width < limits.minWidth || parsed.width > limits.maxWidth || parsed.height < limits.minHeight || parsed.height > limits.maxHeight) {
      return defaultSize
    }
    return parsed
  } catch {
    return defaultSize
  }
}

export function writeFloatingChatSize(storage: Storage | null, size: FloatingChatSize) {
  if (!storage || !isSize(size)) return
  try {
    storage.setItem(FLOATING_CHAT_SIZE_STORAGE_KEY, JSON.stringify(size))
  } catch {
    // Storage can be unavailable in private browsing or restricted embeds.
  }
}
