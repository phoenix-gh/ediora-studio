import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from '../../wemedia-studio/node_modules/jsdom/lib/api.js'

import { normalizeMarkdownUrl, renderMarkdown } from '../content/markdown-renderer.js'

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
  assert.equal(
    result.element.querySelector('img')?.getAttribute('src'),
    'http://localhost:8000/api/uploads/cover.png',
  )
  assert.match(result.html, /<img[^>]+class="sw-markdown-image"/)
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
