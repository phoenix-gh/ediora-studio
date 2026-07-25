const MAX_TITLE_LENGTH = 30

export function titleFromFirstMessage(message: string) {
  const normalized = message.trim().replace(/\s+/g, ' ')
  return normalized.length > MAX_TITLE_LENGTH ? `${normalized.slice(0, MAX_TITLE_LENGTH)}…` : normalized
}
