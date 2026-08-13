const URL_PROTOCOLS = new Set(['http:', 'https:'])

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

function appendInline(document, parent, value, apiBase) {
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
          image.setAttribute('src', src)
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
          appendInline(document, link, match[1], apiBase)
          if (match[3]) link.setAttribute('title', match[3])
          parent.appendChild(link)
        } else {
          appendInline(document, parent, match[1], apiBase)
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
        appendInline(document, element, text.slice(cursor + pairMarker.length, end), apiBase)
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
        appendInline(document, emphasis, text.slice(cursor + 1, end), apiBase)
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

function createParagraph(document, lines, apiBase) {
  const paragraph = document.createElement('p')
  paragraph.className = 'sw-markdown-paragraph'
  lines.forEach((line, index) => {
    if (index > 0) paragraph.appendChild(document.createElement('br'))
    appendInline(document, paragraph, line, apiBase)
  })
  return paragraph
}

function createList(document, lines, ordered, apiBase) {
  const list = document.createElement(ordered ? 'ol' : 'ul')
  list.className = ordered ? 'sw-markdown-list sw-markdown-list-ordered' : 'sw-markdown-list'
  const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/
  lines.forEach(line => {
    const match = pattern.exec(line)
    if (!match) return
    const item = document.createElement('li')
    appendInline(document, item, match[1], apiBase)
    list.appendChild(item)
  })
  return list
}

function createBlockquote(document, lines, apiBase) {
  const quote = document.createElement('blockquote')
  quote.className = 'sw-markdown-blockquote'
  lines.forEach((line, index) => {
    if (index > 0) quote.appendChild(document.createElement('br'))
    appendInline(document, quote, line.replace(/^\s{0,3}>\s?/, ''), apiBase)
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

function appendBlocks(document, root, markdown, apiBase) {
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
      appendInline(document, element, heading[2], apiBase)
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
      root.appendChild(createList(document, listLines, ordered, apiBase))
      continue
    }

    if (isQuote(line)) {
      const quoteLines = []
      while (index < lines.length && (isQuote(lines[index]) || isBlank(lines[index]))) {
        if (isBlank(lines[index]) && quoteLines.length && !isQuote(lines[index + 1] || '')) break
        quoteLines.push(lines[index])
        index += 1
      }
      root.appendChild(createBlockquote(document, quoteLines, apiBase))
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
    root.appendChild(createParagraph(document, paragraphLines, apiBase))
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

export function renderMarkdown(markdown, { document, apiBase = '' } = {}) {
  if (!document?.createElement || !document?.createTextNode) {
    throw new TypeError('Markdown renderer requires a DOM document')
  }

  const element = document.createElement('div')
  element.className = 'sw-markdown'
  appendBlocks(document, element, markdown, apiBase)
  return { element, html: element.innerHTML }
}
