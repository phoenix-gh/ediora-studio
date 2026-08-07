import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

export type ClipboardRemoteImage = {
  id: string
  sourceUrl: string
}

export type ClipboardConversion = {
  markdown: string
  images: ClipboardRemoteImage[]
}

const REMOVED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'svg',
].join(',')

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i
const INTERNAL_IMAGE_TITLE = /(!\[[^\]\n]*\]\([^\n]*?)\s+["']wms-import(?:-failed)?:[^"'\n]+["'](\))/g

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function nextImageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function imageImportMarker(id: string) {
  return `wms-import:${id}`
}

export function stripImageImportMarkers(markdown: string) {
  return markdown.replace(INTERNAL_IMAGE_TITLE, '$1$2')
}

export function imageUrlFromPlainText(value: string): string | null {
  const candidate = value.trim()
  if (!candidate || /\s/.test(candidate) || !isHttpUrl(candidate)) return null
  return IMAGE_PATH.test(candidate) ? candidate : null
}

function sanitizeDocument(document: Document) {
  document.querySelectorAll(REMOVED_ELEMENTS).forEach(element => element.remove())
  document.querySelectorAll('*').forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (
        name === 'style'
        || name === 'class'
        || name === 'id'
        || name.startsWith('on')
      ) {
        element.removeAttribute(attribute.name)
      }
    }
    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute('href') ?? ''
      if (href && !isHttpUrl(href) && !href.startsWith('mailto:') && !href.startsWith('#')) {
        element.removeAttribute('href')
      }
    }
  })
}

export function convertClipboardHtml(html: string): ClipboardConversion {
  const document = new DOMParser().parseFromString(html, 'text/html')
  sanitizeDocument(document)
  const images: ClipboardRemoteImage[] = []

  document.querySelectorAll('img').forEach(image => {
    const sourceUrl = image.getAttribute('src')?.trim() ?? ''
    if (!isHttpUrl(sourceUrl)) {
      image.remove()
      return
    }
    const id = nextImageId()
    image.setAttribute('title', imageImportMarker(id))
    images.push({ id, sourceUrl })
  })

  const turndown = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    fence: '```',
    headingStyle: 'atx',
  })
  turndown.use(gfm)

  return {
    markdown: turndown.turndown(document.body).trim(),
    images,
  }
}

