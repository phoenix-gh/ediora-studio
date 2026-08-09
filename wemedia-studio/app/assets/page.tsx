import { AssetsClient } from './AssetsClient'
import { listCreativeAssets } from '@/lib/api/assets'
export const dynamic = 'force-dynamic'
export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>
}) {
  const [assets, params] = await Promise.all([listCreativeAssets(), searchParams])
  return <AssetsClient initialAssets={assets} initialSelectedId={params.selected ? Number(params.selected) || null : null} />
}
