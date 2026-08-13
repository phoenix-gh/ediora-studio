import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const extensionRoot = resolve(import.meta.dirname, '..')

async function loadManifest() {
  return JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'))
}

async function readRuntimeSources() {
  const paths = [
    'background/service-worker.js',
    'background/draft-api.js',
    'content/contracts.js',
    'content/draft-client.js',
    'content/draft-model.js',
    'content/markdown-renderer.js',
    'content/publisher.js',
    'content/schedule-memory.js',
    'content/selectors.js',
    'content/workbench-clipboard.js',
    'content/workbench-runtime.js',
    'content/workbench-state.js',
    'content/x-dom-driver.js',
  ]
  return Promise.all(paths.map(async relativePath => ({
    relativePath,
    source: await readFile(resolve(extensionRoot, relativePath), 'utf8'),
  })))
}

test('declares the MV3 Shuce extension with X-only host permissions', async () => {
  const manifest = await loadManifest()

  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.name, '述策助手')
  assert.deepEqual(manifest.host_permissions.sort(), [
    'http://127.0.0.1:8000/*',
    'http://localhost:8000/*',
    'https://twitter.com/*',
    'https://x.com/*',
  ])
  assert.equal(manifest.background.type, 'module')
  assert.deepEqual(manifest.content_scripts[0].js, ['content/workbench.js'])
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false)
  assert.deepEqual(manifest.web_accessible_resources[0].resources.sort(), [
    'content/draft-client.js',
    'content/draft-model.js',
    'content/markdown-renderer.js',
    'content/schedule-memory.js',
    'content/selectors.js',
    'content/workbench-clipboard.js',
    'content/workbench-runtime.js',
    'content/workbench-state.js',
  ])
  assert.equal(JSON.stringify(manifest).includes('bridge'), false)
  assert.equal(JSON.stringify(manifest).includes('console-api'), false)
})

test('keeps runtime access X-only and free of browser credentials', async () => {
  const sources = await readRuntimeSources()
  for (const { relativePath, source } of sources) {
    assert.equal(/https?:\/\/(?!x\.com|twitter\.com|localhost:8000|127\.0\.0\.1:8000)/i.test(source), false, relativePath)
    assert.equal(/document\.cookie|authorization|auth_token|ct0/i.test(source), false, relativePath)
  }
})

test('ships the operating guide and auditable XActions notices', async () => {
  const readme = await readFile(resolve(extensionRoot, 'README.md'), 'utf8')
  const notices = await readFile(resolve(extensionRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')

  assert.doesNotMatch(readme, /Shuce\.publish/)
  assert.doesNotMatch(readme, /dryRun/)
  assert.doesNotMatch(readme, /控制台命令/)
  assert.match(readme, /悬浮发布指挥台/)
  assert.match(readme, /status=ready/)
  assert.match(readme, /复制 Markdown/)
  assert.match(readme, /发布并下一条/)
  assert.match(readme, /status=published/)
  assert.match(readme, /不执行 X 的实际发布动作/)
  assert.match(readme, /上次安排/)
  assert.match(readme, /右上角/)
  assert.match(notices, /3c0d8d335fe4bc8a81f5093155e4e60c33dd8312/)
  assert.match(notices, /scripts\/postThread\.js/)
  assert.match(notices, /scripts\/twitter\/schedule-post\.js/)
  assert.match(notices, /src\/schedulePosts\.js/)
  assert.match(notices, /Apache License, Version 2\.0/)
  assert.match(notices, /MIT License/)
  assert.doesNotMatch(notices, /控制台 API 只是当前版本的临时入口/)
})
