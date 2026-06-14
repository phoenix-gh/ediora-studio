import { getPublications } from '@/lib/api/published'
import { PublishedClient } from './PublishedClient'

export const dynamic = 'force-dynamic'

export default async function PublishedPage() {
  const initial = await getPublications().catch(() => [])
  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">发布</h1>
      <p className="text-sm text-zinc-500 mb-6">
        已发布文章的表现回填——阅读 / 点赞 / 在看 / 分享，按阅读量排序。
      </p>
      <PublishedClient initial={initial} />
    </div>
  )
}
