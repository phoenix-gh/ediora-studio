import { describe, expect, it } from 'vitest'

import type { Draft } from '@/lib/api/drafts'
import { runBulkOperations } from './draft-bulk-operations'

function makeDraft(
  id: number,
  draftType: string,
): Draft {
  return {
    id,
    topic_id: `topic-${id}`,
    writing_plan_id: null,
    title: `草稿 ${id}`,
    content: `正文 ${id}`,
    status: 'drafting',
    draft_type: draftType,
    series_id: null,
    series_order: 0,
    version: 1,
    sources: [],
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('runBulkOperations', () => {
  it('limits concurrency to three and preserves settled results in input order', async () => {
    const drafts = [1, 2, 3, 4, 5].map(id => makeDraft(id, id === 2 ? 'x' : 'article'))
    const pending = drafts.map(() => deferred<void>())
    const progress: Array<[number, number]> = []
    const started: number[] = []
    let active = 0
    let maximumActive = 0

    const resultPromise = runBulkOperations(
      drafts,
      async (_draft, index) => {
        started.push(index)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          await pending[index].promise
        } finally {
          active -= 1
        }
      },
      (completed, total) => progress.push([completed, total]),
    )

    await Promise.resolve()
    expect(started).toEqual([0, 1, 2])
    expect(maximumActive).toBe(3)

    pending[1].reject(new Error('第二组失败'))
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])

    pending[0].resolve()
    pending[2].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3, 4])

    pending[3].resolve()
    pending[4].resolve()
    const results = await resultPromise

    expect(results.map(result => [result.draftId, result.status, result.reason])).toEqual([
      [1, 'fulfilled', undefined],
      [2, 'rejected', '第二组失败'],
      [3, 'fulfilled', undefined],
      [4, 'fulfilled', undefined],
      [5, 'fulfilled', undefined],
    ])
    expect(progress).toHaveLength(5)
    expect(progress.at(-1)).toEqual([5, 5])
  })

  it('returns immediately for an empty selection', async () => {
    await expect(runBulkOperations([], async () => {})).resolves.toEqual([])
  })
})
