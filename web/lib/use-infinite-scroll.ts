'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * IntersectionObserver-based infinite scroll.
 *
 * Returns `{ visibleCount, sentinelRef, hasMore, reset }`. Attach `sentinelRef` to a
 * sentinel `<div>` at the bottom of the list; when it enters view and `hasMore` is true,
 * `visibleCount` advances by `pageSize`. Call `reset()` after a filter/search change.
 */
export function useInfiniteScroll(opts: {
  totalCount: number
  pageSize: number
  rootMargin?: string
}): {
  visibleCount: number
  sentinelRef: RefObject<HTMLDivElement | null>
  hasMore: boolean
  reset: () => void
} {
  const { totalCount, pageSize, rootMargin = '200px' } = opts
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const hasMore = visibleCount < totalCount

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && hasMore) setVisibleCount(c => c + pageSize) },
      { rootMargin },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, pageSize, rootMargin])

  return {
    visibleCount,
    sentinelRef,
    hasMore,
    reset: () => setVisibleCount(pageSize),
  }
}
