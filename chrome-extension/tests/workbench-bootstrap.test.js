import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const extensionRoot = resolve(import.meta.dirname, '..')

test('keeps the content-script bootstrap limited to the extension runtime boundary', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench.js'), 'utf8')

  assert.match(source, /chrome\.runtime\.getURL\(['"]content\/workbench-runtime\.js['"]\)/)
  assert.match(source, /import\(runtimeUrl\)/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /document\.cookie|Authorization|SHUCE_PUBLISH_REQUEST/)
})

test('anchors the command center and panel to the upper-right corner', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench-runtime.js'), 'utf8')

  assert.match(source, /\.sw-entry \{[^}]*right: 24px; top: 24px;/s)
  assert.match(source, /\.sw-panel \{[^}]*right: 24px; top: 84px;/s)
  assert.match(source, /\.sw-entry \{ right: 16px; top: 16px;/s)
  assert.match(source, /\.sw-panel \{ right: 8px; top: 74px;/s)
})
