export function isChatToolPart(part: { type: string }) {
  return part.type === 'dynamic-tool'
    || part.type === 'tool-event'
    || part.type === 'tool-result'
    || part.type.startsWith('tool-')
}
