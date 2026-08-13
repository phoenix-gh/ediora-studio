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

export async function copyMarkdown(markdown, {
  html = '',
  clipboard = globalThis.navigator?.clipboard,
  document = globalThis.document,
  clipboardItemClass = globalThis.ClipboardItem,
  blobClass = globalThis.Blob,
} = {}) {
  const value = String(markdown ?? '')
  const rendered = String(html ?? '')

  if (clipboard && typeof clipboard.write === 'function'
    && typeof clipboardItemClass === 'function' && typeof blobClass === 'function') {
    try {
      const item = new clipboardItemClass({
        'text/plain': new blobClass([value], { type: 'text/plain' }),
        'text/html': new blobClass([rendered], { type: 'text/html' }),
      })
      await clipboard.write([item])
      return 'rich'
    } catch {
      // Fall back to the plain Markdown path when rich clipboard is unavailable.
    }
  }

  await copyText(value, { clipboard, document })
  return 'plain'
}
