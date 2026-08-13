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

test('fills the side panel viewport instead of anchoring an overlay', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench-runtime.js'), 'utf8')

  assert.match(source, /\.sw-root \{[^}]*inset: 0/s)
  assert.match(source, /data-layout/)
  assert.doesNotMatch(source, /\.sw-entry \{[^}]*right: 24px; top: 24px;/s)
})

test('mounts the workbench as a full-viewport side panel', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench-runtime.js'), 'utf8')
  assert.match(source, /surface !== ['"]sidepanel['"]/)
  assert.doesNotMatch(source, /shuce-floating-draft-workbench/)
  assert.doesNotMatch(source, /data-action="toggle"/)
  assert.doesNotMatch(source, /data-action="close"/)
  assert.match(source, /data-action="layout"/)
  assert.match(source, /createScheduleClient/)
})

test('shows the last X schedule selection inside the workbench', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench-runtime.js'), 'utf8')

  assert.match(source, /from ['"]\.\/schedule-memory\.js['"]/)
  assert.match(source, /data-role="last-schedule"/)
  assert.match(source, /上次安排：未记录/)
})

test('exposes the publish-and-next action in the workbench runtime', async () => {
  const source = await readFile(resolve(extensionRoot, 'content/workbench-runtime.js'), 'utf8')

  assert.match(source, /data-action="publish"/)
  assert.match(source, /发布并下一条/)
  assert.match(source, /client\.publishDraft\(/)
  assert.match(source, /publishDraftAndSelectNext/)
})
