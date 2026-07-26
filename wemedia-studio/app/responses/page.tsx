import { listPublishAccounts } from '@/lib/api/publish-accounts'
import { getResponses } from '@/lib/api/responses'
import { ResponsesClient } from './ResponsesClient'

export const dynamic = 'force-dynamic'

export default async function ResponsesPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string; source_type?: string }>
}) {
  const query = await searchParams
  const [responses, accounts] = await Promise.all([
    getResponses({ source_type: query.source_type }).catch(() => ({ items: [], total: 0, page: 1, page_size: 30 })),
    listPublishAccounts().catch(() => []),
  ])
  return (
    <ResponsesClient
      initialItems={responses.items}
      initialTotal={responses.total}
      accounts={accounts.filter(account => account.is_active)}
      initialSelectedId={Number(query.selected) || null}
      initialSource={query.source_type ?? ''}
    />
  )
}
