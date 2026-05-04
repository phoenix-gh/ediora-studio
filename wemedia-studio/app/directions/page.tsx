import { Suspense } from 'react'
import { DirectionsClient } from './DirectionsClient'

export default function DirectionsPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center text-zinc-400 text-sm">加载中…</div>
    }>
      <DirectionsClient />
    </Suspense>
  )
}
