import { getQuotes } from '@/lib/api/quotes'
import { getTopics } from '@/lib/api/content-topics'
import { QuotesClient } from './QuotesClient'

export const dynamic = 'force-dynamic'

export default async function QuotesPage() {
  const [quotes, topics] = await Promise.all([getQuotes(), getTopics()])
  return <QuotesClient initialQuotes={quotes} initialTopics={topics} />
}
