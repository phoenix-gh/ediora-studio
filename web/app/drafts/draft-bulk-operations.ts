import type { Draft } from '@/lib/api/drafts'

export interface BulkOperationResult {
  draftId: number
  title: string
  status: 'fulfilled' | 'rejected'
  reason?: string
}

export async function runBulkOperations(
  drafts: Draft[],
  operation: (draft: Draft, index: number) => Promise<void>,
  onProgress: (completed: number, total: number) => void = () => {},
  concurrency = 3,
): Promise<BulkOperationResult[]> {
  if (drafts.length === 0) return []

  const results = new Array<BulkOperationResult>(drafts.length)
  let cursor = 0
  let completed = 0

  async function worker() {
    while (cursor < drafts.length) {
      const index = cursor++
      const draft = drafts[index]
      try {
        await operation(draft, index)
        results[index] = {
          draftId: draft.id,
          title: draft.title,
          status: 'fulfilled',
        }
      } catch (error) {
        results[index] = {
          draftId: draft.id,
          title: draft.title,
          status: 'rejected',
          reason: error instanceof Error ? error.message : '操作失败',
        }
      } finally {
        completed += 1
        onProgress(completed, drafts.length)
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), drafts.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
