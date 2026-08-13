import assert from 'node:assert/strict'
import test from 'node:test'

import { copyMarkdown } from '../content/workbench-clipboard.js'

test('copies original markdown and rendered html when rich clipboard is available', async () => {
  const writes = []
  class FakeClipboardItem {
    constructor(items) {
      this.items = items
    }
  }

  const result = await copyMarkdown('![图](/api/uploads/a.png)', {
    html: '<p><img src="http://localhost:8000/api/uploads/a.png"></p>',
    clipboard: { write: async items => writes.push(items) },
    clipboardItemClass: FakeClipboardItem,
    blobClass: Blob,
  })

  assert.equal(result, 'rich')
  assert.equal(writes.length, 1)
  assert.equal(
    await writes[0][0].items['text/plain'].text(),
    '![图](/api/uploads/a.png)',
  )
  assert.match(await writes[0][0].items['text/html'].text(), /<img/)
})

test('falls back to copying original markdown as plain text', async () => {
  const copied = []
  const result = await copyMarkdown('正文', {
    html: '<p>正文</p>',
    clipboard: { writeText: async value => copied.push(value) },
    document: { createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {} }), body: { appendChild() {} } },
  })

  assert.equal(result, 'plain')
  assert.deepEqual(copied, ['正文'])
})
