import { afterEach, expect, it, vi } from 'vitest'


afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it('uses the public API origin for browser-facing video downloads', async () => {
  vi.stubEnv('API_URL', 'http://api:8000/api')
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000/api')
  vi.resetModules()

  const { textVideoOutputDownloadUrl } = await import('./text-videos')

  expect(textVideoOutputDownloadUrl(2)).toBe(
    'http://localhost:8000/api/text-videos/2/output/download',
  )
})

it('uses the same-origin API proxy for browser-facing video downloads', async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost:8800' } })
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000/api')
  vi.resetModules()

  const { textVideoOutputDownloadUrl } = await import('./text-videos')

  expect(textVideoOutputDownloadUrl(2)).toBe(
    '/_ediora-api/text-videos/2/output/download',
  )
})
