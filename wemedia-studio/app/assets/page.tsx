import { AssetsClient } from './AssetsClient'
import { listCreativeAssets } from '@/lib/api/assets'
export const dynamic = 'force-dynamic'
export default async function AssetsPage() { return <AssetsClient initialAssets={await listCreativeAssets()} /> }
