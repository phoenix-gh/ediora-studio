import { getQuotes } from '@/lib/api/quotes'
import { getWritingPlans } from '@/lib/api/writing-plans'
import { QuotesClient } from './QuotesClient'

export const dynamic = 'force-dynamic'

export default async function QuotesPage() {
  const [quotes, plans] = await Promise.all([getQuotes(), getWritingPlans()])
  return <QuotesClient initialQuotes={quotes} initialPlans={plans} />
}
