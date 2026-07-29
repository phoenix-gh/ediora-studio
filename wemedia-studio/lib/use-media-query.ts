'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Subscribe to a CSS media query and return whether it currently matches.
 * SSR-safe: starts as `false`, then syncs on mount.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onStoreChange)
    return () => mql.removeEventListener('change', onStoreChange)
  }, [query])

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
