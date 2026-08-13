import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { sidePanelOptionsForUrl } from '../background/service-worker.js'

test('enables the side panel only on X tabs', () => {
  assert.deepEqual(sidePanelOptionsForUrl('https://x.com/home'), {
    path: 'sidepanel/index.html',
    enabled: true,
  })
  assert.deepEqual(sidePanelOptionsForUrl('https://github.com/'), {
    path: 'sidepanel/index.html',
    enabled: false,
  })
  assert.equal(sidePanelOptionsForUrl(undefined).enabled, false)
})

function topLevelIfBlock(source, header) {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `missing ${header}`)
  const open = source.indexOf('{', start + header.length)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unclosed ${header}`)
}

test('wires site gating and schedule routing without auto-opening', async () => {
  const source = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8')
  assert.match(source, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/)
  assert.match(source, /tabs\.onUpdated/)
  assert.match(source, /tabs\.onActivated/)
  assert.match(source, /SHUCE_SCHEDULE_GET/)
  assert.match(source, /routeScheduleRequest/)
  assert.doesNotMatch(source, /sidePanel\.open\(/)

  const sidePanelBlock = topLevelIfBlock(source, 'if (globalThis.chrome?.sidePanel)')
  const runtimeBlock = topLevelIfBlock(source, 'if (globalThis.chrome?.runtime)')
  assert.doesNotMatch(sidePanelBlock, /onMessage/)
  assert.match(runtimeBlock, /onMessage\.addListener/)
})
