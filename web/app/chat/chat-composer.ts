type ComposerKeyEvent = {
  key: string
  shiftKey: boolean
  isComposing: boolean
}

export function shouldSubmitChatComposerKey({ key, shiftKey, isComposing }: ComposerKeyEvent) {
  return key === 'Enter' && !shiftKey && !isComposing
}
