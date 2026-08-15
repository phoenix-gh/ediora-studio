import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from '../../web/node_modules/jsdom/lib/api.js'

import {
  hydrateMarkdownImages,
  isLocalUploadUrl,
  normalizeMarkdownUrl,
  renderMarkdown,
} from '../content/markdown-renderer.js'

function createDocument() {
  return new JSDOM('<!doctype html><html><body></body></html>').window.document
}

test('renders markdown structure and resolves local asset images', () => {
  const document = createDocument()
  const result = renderMarkdown(
    '# 标题\n\n正文 **重点**。\n\n- 一\n- 二\n\n![封面](/api/uploads/cover.png)',
    { document, apiBase: 'http://localhost:8000/api' },
  )

  assert.equal(result.element.querySelector('h1')?.textContent, '标题')
  assert.equal(result.element.querySelector('strong')?.textContent, '重点')
  assert.deepEqual(
    [...result.element.querySelectorAll('li')].map(node => node.textContent),
    ['一', '二'],
  )
  assert.equal(result.element.querySelector('img')?.getAttribute('src'), null)
  assert.equal(
    result.element.querySelector('img')?.getAttribute('data-sw-image-src'),
    'http://localhost:8000/api/uploads/cover.png',
  )
  assert.match(result.html, /<img[^>]+class="sw-markdown-image"/)
})

test('defers local upload images instead of putting the API URL in img src', () => {
  const document = createDocument()
  const result = renderMarkdown(
    '![封面](/api/uploads/cover.png)',
    { document, apiBase: 'http://localhost:8000/api' },
  )
  const image = result.element.querySelector('img')

  assert.equal(image?.getAttribute('src'), null)
  assert.equal(
    image?.getAttribute('data-sw-image-src'),
    'http://localhost:8000/api/uploads/cover.png',
  )
})

test('treats localhost and 127.0.0.1 upload URLs as the same local API', () => {
  const document = createDocument()
  const result = renderMarkdown(
    '![封面](http://127.0.0.1:8000/api/uploads/cover.png)',
    { document, apiBase: 'http://localhost:8000/api' },
  )
  const image = result.element.querySelector('img')

  assert.equal(
    isLocalUploadUrl('http://127.0.0.1:8000/api/uploads/cover.png', 'http://localhost:8000/api'),
    true,
  )
  assert.equal(
    isLocalUploadUrl('http://localhost:8000/api/uploads/cover.png', 'http://127.0.0.1:8000/api'),
    true,
  )
  assert.equal(image?.getAttribute('src'), null)
  assert.equal(
    image?.getAttribute('data-sw-image-src'),
    'http://127.0.0.1:8000/api/uploads/cover.png',
  )
})

test('hydrates deferred local images with a CSP-compatible data URL', async () => {
  const document = createDocument()
  const result = renderMarkdown(
    '![封面](/api/uploads/cover.png)',
    { document, apiBase: 'http://localhost:8000/api' },
  )
  const image = result.element.querySelector('img')

  const hydrated = await hydrateMarkdownImages(result.element, {
    fetchImage: async source => {
      assert.equal(source, 'http://localhost:8000/api/uploads/cover.png')
      return { dataUrl: 'data:image/png;base64,AAAA' }
    },
  })

  assert.equal(hydrated, 1)
  assert.equal(image?.getAttribute('src'), 'data:image/png;base64,AAAA')
  assert.equal(image?.getAttribute('data-sw-image-src'), null)
})

test('reuses cached data URLs instead of refetching the same local image', async () => {
  const document = createDocument()
  const cache = new Map()
  const fetches = []
  const fetchImage = async source => {
    fetches.push(source)
    return { dataUrl: 'data:image/png;base64,AAAA' }
  }

  const first = renderMarkdown('![封面](/api/uploads/cover.png)', {
    document,
    apiBase: 'http://localhost:8000/api',
  })
  await hydrateMarkdownImages(first.element, { fetchImage, cache })

  const second = renderMarkdown('![封面](/api/uploads/cover.png)', {
    document,
    apiBase: 'http://localhost:8000/api',
  })
  await hydrateMarkdownImages(second.element, { fetchImage, cache })

  assert.deepEqual(fetches, ['http://localhost:8000/api/uploads/cover.png'])
  assert.equal(second.element.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,AAAA')
  assert.equal(second.element.querySelector('img')?.getAttribute('data-sw-image-src'), null)
})

test('does not execute raw html or unsafe image and link protocols', () => {
  const document = createDocument()
  const result = renderMarkdown(
    '<script>alert(1)</script> [危险](javascript:alert(1)) ![危险](data:text/html,x)',
    { document, apiBase: 'http://localhost:8000/api' },
  )

  assert.equal(result.element.querySelector('script'), null)
  assert.equal(result.element.querySelector('a'), null)
  assert.equal(result.element.querySelector('img'), null)
  assert.match(result.element.textContent, /危险/)
})

test('rejects unsafe protocols and resolves remote URLs', () => {
  assert.equal(normalizeMarkdownUrl('javascript:alert(1)', 'http://localhost:8000/api'), null)
  assert.equal(normalizeMarkdownUrl('data:image/png;base64,abc', 'http://localhost:8000/api'), null)
  assert.equal(
    normalizeMarkdownUrl('https://example.com/image.png', 'http://localhost:8000/api'),
    'https://example.com/image.png',
  )
})
