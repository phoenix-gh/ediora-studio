import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) return []
    return [path]
  })
}

describe('native select migration', () => {
  it('routes every application native select through the themed control', () => {
    const appRoot = resolve(process.cwd(), 'app')
    const violations = sourceFiles(appRoot)
      .filter(path => readFileSync(path, 'utf8').includes('<select'))
      .map(path => relative(process.cwd(), path))

    expect(violations).toEqual([])
  })
})
