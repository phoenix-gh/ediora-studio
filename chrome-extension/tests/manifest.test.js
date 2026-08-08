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
    'content/bridge-protocol.js',
    'content/bridge.js',
    'content/contracts.js',
    'content/publisher.js',
    'content/selectors.js',
    'content/x-dom-driver.js',
    'injected/console-api.js',
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
    'https://twitter.com/*',
    'https://x.com/*',
  ])
  assert.equal(JSON.stringify(manifest).includes('localhost'), false)
  assert.equal(JSON.stringify(manifest).includes('http://'), false)
  assert.equal(manifest.content_scripts[0].js[0], 'content/bridge.js')
  assert.deepEqual(manifest.web_accessible_resources[0].resources.sort(), [
    'content/bridge-protocol.js',
    'content/contracts.js',
    'content/publisher.js',
    'content/selectors.js',
    'content/x-dom-driver.js',
    'injected/console-api.js',
  ])
})

test('keeps runtime access X-only and free of browser credentials', async () => {
  const sources = await readRuntimeSources()
  for (const { relativePath, source } of sources) {
    assert.equal(/https?:\/\/(?!x\.com|twitter\.com)/i.test(source), false, relativePath)
    assert.equal(/document\.cookie|authorization|auth_token|ct0/i.test(source), false, relativePath)
  }
})

test('ships the operating guide and auditable XActions notices', async () => {
  const readme = await readFile(resolve(extensionRoot, 'README.md'), 'utf8')
  const notices = await readFile(resolve(extensionRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')

  assert.match(readme, /Shuce\.publish/)
  assert.match(readme, /dryRun/)
  assert.match(notices, /3c0d8d335fe4bc8a81f5093155e4e60c33dd8312/)
  assert.match(notices, /scripts\/postThread\.js/)
  assert.match(notices, /scripts\/twitter\/schedule-post\.js/)
  assert.match(notices, /src\/schedulePosts\.js/)
  assert.match(notices, /Apache License, Version 2\.0/)
  assert.match(notices, /MIT License/)
})
