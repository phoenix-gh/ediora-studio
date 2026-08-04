import type { Draft } from '@/lib/api/drafts'

export interface DraftGroup {
  root: Draft
  variants: Draft[]
}

export interface BulkOperationResult {
  groupId: number
  title: string
  status: 'fulfilled' | 'rejected'
  reason?: string
}

export function articleDraftForGroup(group: DraftGroup): Draft | null {
  return [group.root, ...group.variants].find(draft => draft.draft_type === 'article') ?? null
}

export async function deleteDraftGroup(
  group: DraftGroup,
  remove: (id: number) => Promise<void>,
): Promise<void> {
  for (const variant of group.variants) await remove(variant.id)
  await remove(group.root.id)
}

export async function runBulkOperations(
  groups: DraftGroup[],
  operation: (group: DraftGroup, index: number) => Promise<void>,
  onProgress: (completed: number, total: number) => void = () => {},
  concurrency = 3,
): Promise<BulkOperationResult[]> {
  if (groups.length === 0) return []

  const results = new Array<BulkOperationResult>(groups.length)
  let cursor = 0
  let completed = 0

  async function worker() {
    while (cursor < groups.length) {
      const index = cursor++
      const group = groups[index]
      try {
        await operation(group, index)
        results[index] = {
          groupId: group.root.id,
          title: group.root.title,
          status: 'fulfilled',
        }
      } catch (error) {
        results[index] = {
          groupId: group.root.id,
          title: group.root.title,
          status: 'rejected',
          reason: error instanceof Error ? error.message : '操作失败',
        }
      } finally {
        completed += 1
        onProgress(completed, groups.length)
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), groups.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
