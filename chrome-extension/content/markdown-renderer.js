const URL_PROTOCOLS = new Set(['http:', 'https:'])
const LOCAL_API_HOSTS = new Set(['localhost:8000', '127.0.0.1:8000'])

function asText(value) {
  return String(value ?? '')
}

function findClosingMarker(text, marker, start) {
  const end = text.indexOf(marker, start)
  return end > start ? end : -1
}

function appendText(document, parent, value) {
  if (value) parent.appendChild(document.createTextNode(value))
}

function appendInline(document, parent, value, apiBase, deferLocalImages) {
  const text = asText(value)
  let cursor = 0
  let plainStart = 0

  const flushPlain = end => {
    if (end > plainStart) appendText(document, parent, text.slice(plainStart, end))
  }

  const moveTo = nextCursor => {
    cursor = nextCursor
    plainStart = cursor
  }

  while (cursor < text.length) {
    if (text.startsWith('![', cursor)) {
      const match = /^!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/.exec(text.slice(cursor))
      if (match) {
        flushPlain(cursor)
        const src = normalizeMarkdownUrl(match[2], apiBase)
        if (src) {
          const image = document.createElement('img')
          image.className = 'sw-markdown-image'
          if (deferLocalImages && isLocalUploadUrl(src, apiBase)) {
            image.setAttribute('data-sw-image-src', src)
          } else {
            image.setAttribute('src', src)
          }
          image.setAttribute('alt', match[1])
          image.setAttribute('loading', 'lazy')
          image.setAttribute('decoding', 'async')
          image.addEventListener?.('error', () => {
            const fallback = document.createElement('span')
            fallback.className = 'sw-markdown-image-error'
            fallback.textContent = `${match[1] || '图片'}：图片加载失败`
            image.parentNode?.replaceChild(fallback, image)
          }, { once: true })
          parent.appendChild(image)
        } else {
          appendText(document, parent, match[1] || '图片')
        }
        moveTo(cursor + match[0].length)
        continue
      }
    }

    if (text[cursor] === '[') {
      const match = /^\[([^\]]+)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/.exec(text.slice(cursor))
      if (match) {
        flushPlain(cursor)
        const href = normalizeMarkdownUrl(match[2], apiBase)
        if (href) {
          const link = document.createElement('a')
          link.className = 'sw-markdown-link'
          link.setAttribute('href', href)
          link.setAttribute('target', '_blank')
          link.setAttribute('rel', 'noreferrer noopener')
          appendInline(document, link, match[1], apiBase, deferLocalImages)
          if (match[3]) link.setAttribute('title', match[3])
          parent.appendChild(link)
        } else {
          appendInline(document, parent, match[1], apiBase, deferLocalImages)
        }
        moveTo(cursor + match[0].length)
        continue
      }
    }

    if (text[cursor] === '`') {
      const end = findClosingMarker(text, '`', cursor + 1)
      if (end !== -1) {
        flushPlain(cursor)
        const code = document.createElement('code')
        code.className = 'sw-markdown-inline-code'
        code.textContent = text.slice(cursor + 1, end)
        parent.appendChild(code)
        moveTo(end + 1)
        continue
      }
    }

    const pairMarker = text.startsWith('**', cursor) ? '**'
      : text.startsWith('__', cursor) ? '__'
        : text.startsWith('~~', cursor) ? '~~'
          : null
    if (pairMarker) {
      const end = findClosingMarker(text, pairMarker, cursor + pairMarker.length)
      if (end !== -1) {
        flushPlain(cursor)
        const tag = pairMarker === '~~' ? 'del' : 'strong'
        const element = document.createElement(tag)
        element.className = tag === 'del' ? 'sw-markdown-del' : 'sw-markdown-strong'
        appendInline(document, element, text.slice(cursor + pairMarker.length, end), apiBase, deferLocalImages)
        parent.appendChild(element)
        moveTo(end + pairMarker.length)
        continue
      }
    }

    const singleMarker = text[cursor] === '*' ? '*'
      : text[cursor] === '_' && !/\w/.test(text[cursor - 1] || '') ? '_' : null
    if (singleMarker && !text.startsWith(`${singleMarker}${singleMarker}`, cursor)) {
      const end = findClosingMarker(text, singleMarker, cursor + 1)
      if (end !== -1 && !/^\s/.test(text.slice(cursor + 1, end))) {
        flushPlain(cursor)
        const emphasis = document.createElement('em')
        emphasis.className = 'sw-markdown-em'
        appendInline(document, emphasis, text.slice(cursor + 1, end), apiBase, deferLocalImages)
        parent.appendChild(emphasis)
        moveTo(end + 1)
        continue
      }
    }

    cursor += 1
  }

  flushPlain(text.length)
}

function isBlank(line) {
  return /^\s*$/.test(line)
}

function createParagraph(document, lines, apiBase, deferLocalImages) {
  const paragraph = document.createElement('p')
  paragraph.className = 'sw-markdown-paragraph'
  lines.forEach((line, index) => {
    if (index > 0) paragraph.appendChild(document.createElement('br'))
    appendInline(document, paragraph, line, apiBase, deferLocalImages)
  })
  return paragraph
}

function createList(document, lines, ordered, apiBase, deferLocalImages) {
  const list = document.createElement(ordered ? 'ol' : 'ul')
  list.className = ordered ? 'sw-markdown-list sw-markdown-list-ordered' : 'sw-markdown-list'
  const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/
  lines.forEach(line => {
    const match = pattern.exec(line)
    if (!match) return
    const item = document.createElement('li')
    appendInline(document, item, match[1], apiBase, deferLocalImages)
    list.appendChild(item)
  })
  return list
}

function createBlockquote(document, lines, apiBase, deferLocalImages) {
  const quote = document.createElement('blockquote')
  quote.className = 'sw-markdown-blockquote'
  lines.forEach((line, index) => {
    if (index > 0) quote.appendChild(document.createElement('br'))
    appendInline(document, quote, line.replace(/^\s{0,3}>\s?/, ''), apiBase, deferLocalImages)
  })
  return quote
}

function createCodeBlock(document, lines, language) {
  const pre = document.createElement('pre')
  pre.className = 'sw-markdown-code-block'
  const code = document.createElement('code')
  if (language) code.className = `language-${language.replace(/[^\w-]/g, '')}`
  code.textContent = lines.join('\n')
  pre.appendChild(code)
  return pre
}

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line)
}

function isList(line) {
  return /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(line)
}

function isQuote(line) {
  return /^\s{0,3}>/.test(line)
}

function isRule(line) {
  return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)
}

function isFence(line) {
  return /^\s{0,3}```/.test(line)
}

function appendBlocks(document, root, markdown, apiBase, deferLocalImages) {
  const lines = asText(markdown).replace(/\r\n?/g, '\n').split('\n')
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      index += 1
      continue
    }

    const fence = /^\s{0,3}```\s*([^\s`]*)\s*$/.exec(line)
    if (fence) {
      const codeLines = []
      index += 1
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      root.appendChild(createCodeBlock(document, codeLines, fence[1]))
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`)
      element.className = 'sw-markdown-heading'
      appendInline(document, element, heading[2], apiBase, deferLocalImages)
      root.appendChild(element)
      index += 1
      continue
    }

    if (isRule(line)) {
      const rule = document.createElement('hr')
      rule.className = 'sw-markdown-rule'
      root.appendChild(rule)
      index += 1
      continue
    }

    if (isList(line)) {
      const ordered = /^\s{0,3}\d+[.)]\s+/.test(line)
      const listLines = []
      while (index < lines.length && isList(lines[index])) {
        const currentOrdered = /^\s{0,3}\d+[.)]\s+/.test(lines[index])
        if (currentOrdered !== ordered) break
        listLines.push(lines[index])
        index += 1
      }
      root.appendChild(createList(document, listLines, ordered, apiBase, deferLocalImages))
      continue
    }

    if (isQuote(line)) {
      const quoteLines = []
      while (index < lines.length && (isQuote(lines[index]) || isBlank(lines[index]))) {
        if (isBlank(lines[index]) && quoteLines.length && !isQuote(lines[index + 1] || '')) break
        quoteLines.push(lines[index])
        index += 1
      }
      root.appendChild(createBlockquote(document, quoteLines, apiBase, deferLocalImages))
      continue
    }

    const paragraphLines = [line]
    index += 1
    while (index < lines.length && !isBlank(lines[index])
      && !isHeading(lines[index]) && !isList(lines[index]) && !isQuote(lines[index])
      && !isRule(lines[index]) && !isFence(lines[index])) {
      paragraphLines.push(lines[index])
      index += 1
    }
    root.appendChild(createParagraph(document, paragraphLines, apiBase, deferLocalImages))
  }
}

export function normalizeMarkdownUrl(source, apiBase = '') {
  const value = asText(source).trim()
  if (!value) return null

  try {
    const base = apiBase ? new URL(apiBase) : undefined
    const url = new URL(value, base)
    if (!URL_PROTOCOLS.has(url.protocol)) return null
    return url.href
  } catch {
    return null
  }
}

export function isLocalUploadUrl(source, apiBase = '') {
  try {
    const url = new URL(source)
    const base = new URL(apiBase)
    const basePath = base.pathname.replace(/\/+$/, '')
    return LOCAL_API_HOSTS.has(url.host) && url.pathname.startsWith(`${basePath}/uploads/`)
  } catch {
    return false
  }
}

const DATA_IMAGE_URL = /^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp);base64,/i

function asDataImageUrl(value) {
  const dataUrl = typeof value === 'string' ? value : value?.dataUrl
  return DATA_IMAGE_URL.test(dataUrl || '') ? dataUrl : null
}

export async function hydrateMarkdownImages(root, { fetchImage, cache } = {}) {
  if (!root?.querySelectorAll || typeof fetchImage !== 'function') return 0

  const images = [...root.querySelectorAll('img[data-sw-image-src]')]
  let hydrated = 0
  await Promise.all(images.map(async image => {
    const source = image.getAttribute('data-sw-image-src')
    if (!source) return

    try {
      let dataUrl = asDataImageUrl(cache?.get?.(source))
      if (!dataUrl) {
        dataUrl = asDataImageUrl(await fetchImage(source))
        if (!dataUrl) throw new Error('Image response is invalid')
        cache?.set?.(source, dataUrl)
      }
      image.setAttribute('src', dataUrl)
      image.removeAttribute('data-sw-image-src')
      hydrated += 1
    } catch {
      const document = image.ownerDocument
      const fallback = document?.createElement?.('span')
      if (!fallback) return
      fallback.className = 'sw-markdown-image-error'
      fallback.textContent = `${image.getAttribute('alt') || '图片'}：图片加载失败`
      image.parentNode?.replaceChild(fallback, image)
    }
  }))
  return hydrated
}

export function renderMarkdown(markdown, {
  document,
  apiBase = '',
  deferLocalImages = true,
} = {}) {
  if (!document?.createElement || !document?.createTextNode) {
    throw new TypeError('Markdown renderer requires a DOM document')
  }

  const element = document.createElement('div')
  element.className = 'sw-markdown'
  appendBlocks(document, element, markdown, apiBase, deferLocalImages)
  return { element, html: element.innerHTML }
}
