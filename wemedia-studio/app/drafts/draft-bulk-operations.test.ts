import { describe, expect, it } from 'vitest'

import type { Draft } from '@/lib/api/drafts'
import {
  articleDraftForGroup,
  deleteDraftGroup,
  runBulkOperations,
  type DraftGroup,
} from './draft-bulk-operations'

function makeDraft(
  id: number,
  draftType: string,
  linkedDraftId: number | null = null,
): Draft {
  return {
    id,
    topic_id: `topic-${id}`,
    writing_plan_id: null,
    title: `草稿 ${id}`,
    content: `正文 ${id}`,
    status: 'drafting',
    draft_type: draftType,
    linked_draft_id: linkedDraftId,
    series_id: null,
    series_order: 0,
    version: 1,
    sources: [],
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
  }
}

function makeGroup(id: number): DraftGroup {
  return { root: makeDraft(id, 'article'), variants: [] }
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

describe('draft bulk group semantics', () => {
  it('resolves only the article draft in a group', () => {
    const article = makeDraft(1, 'article')
    const xVariant = makeDraft(2, 'x', 1)

    expect(articleDraftForGroup({ root: article, variants: [xVariant] })?.id).toBe(1)
    expect(articleDraftForGroup({ root: makeDraft(3, 'x', 99), variants: [] })).toBeNull()
  })

  it('deletes variants before the group root', async () => {
    const calls: number[] = []
    await deleteDraftGroup(
      {
        root: makeDraft(1, 'article'),
        variants: [makeDraft(2, 'x', 1), makeDraft(3, 'mp', 1)],
      },
      async id => { calls.push(id) },
    )

    expect(calls).toEqual([2, 3, 1])
  })
})

describe('runBulkOperations', () => {
  it('limits concurrency to three and preserves settled results in input order', async () => {
    const groups = [1, 2, 3, 4, 5].map(makeGroup)
    const pending = groups.map(() => deferred<void>())
    const progress: Array<[number, number]> = []
    const started: number[] = []
    let active = 0
    let maximumActive = 0

    const resultPromise = runBulkOperations(
      groups,
      async (_group, index) => {
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

    expect(results.map(result => [result.groupId, result.status, result.reason])).toEqual([
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
