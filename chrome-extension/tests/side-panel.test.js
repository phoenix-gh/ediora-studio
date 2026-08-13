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

test('wires site gating and schedule routing without auto-opening', async () => {
  const source = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8')
  assert.match(source, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/)
  assert.match(source, /tabs\.onUpdated/)
  assert.match(source, /tabs\.onActivated/)
  assert.match(source, /SHUCE_SCHEDULE_GET/)
  assert.match(source, /routeScheduleRequest/)
  assert.doesNotMatch(source, /sidePanel\.open\(/)
})
