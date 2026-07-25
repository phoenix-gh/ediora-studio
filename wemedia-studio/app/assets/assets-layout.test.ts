import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'app/assets/AssetsClient.tsx'), 'utf8')

describe('creative asset media layout', () => {
  it('opens multimedia cards in a dialog and keeps the article preview separate', () => {
    expect(source).toContain('onDoubleClick={() => setPreviewAsset(item)}')
    expect(source).toContain('<Dialog open={previewAsset !== null}')
    expect(source).toContain("type === 'article' && <aside")
    expect(source).toContain('grid-cols-3 content-start gap-3 p-4 md:grid-cols-6 xl:grid-cols-8')
  })
})
