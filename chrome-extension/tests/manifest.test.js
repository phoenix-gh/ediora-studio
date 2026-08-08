import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const extensionRoot = resolve(import.meta.dirname, '..')

async function loadManifest() {
  return JSON.parse(await readFile(resolve(extensionRoot, 'manifest.json'), 'utf8'))
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
})
