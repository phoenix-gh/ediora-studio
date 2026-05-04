import { Suspense } from 'react'
import { TopicsClient } from './TopicsClient'
import { Skeleton } from '@/components/ui/skeleton'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ id?: string }>
}

export default async function TopicsPage({ searchParams }: Props) {
  const { id } = await searchParams
  return (
    <Suspense fallback={
      <div className="max-w-[900px] mx-auto px-8 py-8 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[100px] rounded-xl" />)}
      </div>
    }>
      <TopicsClient initialId={id} />
    </Suspense>
  )
}
