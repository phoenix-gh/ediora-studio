function clipboardError() {
  const error = new Error('复制失败，请手动选择正文复制')
  error.code = 'CLIPBOARD_FAILED'
  return error
}

export async function copyText(text, {
  clipboard = globalThis.navigator?.clipboard,
  document = globalThis.document,
} = {}) {
  const value = String(text ?? '')

  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value)
      return
    } catch {
      // Try the DOM fallback below when the async clipboard is unavailable.
    }
  }

  if (!document?.createElement || !document.body || typeof document.execCommand !== 'function') {
    throw clipboardError()
  }

  let textarea
  try {
    textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    if (!document.execCommand('copy')) throw clipboardError()
  } catch (error) {
    if (error?.code === 'CLIPBOARD_FAILED') throw error
    throw clipboardError()
  } finally {
    textarea?.remove?.()
  }
}
