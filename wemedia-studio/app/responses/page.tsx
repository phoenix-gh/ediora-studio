import { getResponses } from '@/lib/api/responses'
import { ResponsesClient } from './ResponsesClient'

export const dynamic = 'force-dynamic'

export default async function ResponsesPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string; source_type?: string }>
}) {
  const query = await searchParams
  const responses = await getResponses({ source_type: query.source_type, days: 3, page: 1 }).catch(() => ({
    items: [],
    counts: { all: 0, pending: 0, worth_writing: 0, creative_asset: 0, not_processed: 0 },
    total: 0,
    page: 1,
    page_size: 30,
  }))
  return (
    <ResponsesClient
      initialItems={responses.items}
      initialTotal={responses.total}
      initialSelectedId={Number(query.selected) || null}
      initialSource={query.source_type ?? ''}
    />
  )
}
