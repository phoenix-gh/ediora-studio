'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { getJob, getJobEvents, type ContentJob } from '@/lib/api/jobs'

const terminalStatuses = new Set<ContentJob['status']>(['succeeded', 'failed', 'cancelled', 'superseded'])
const activeStatuses = new Set<ContentJob['status']>(['queued', 'running'])

function initialCursor(job?: ContentJob) {
  return Math.max(0, ...(job?.events ?? []).map(event => event.id))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '加载 Pipeline 状态失败'
}

export function usePipelineJob(jobId: number, initialJob?: ContentJob) {
  const [job, setJobState] = useState<ContentJob | null>(initialJob ?? null)
  const [loading, setLoading] = useState(initialJob === undefined)
  const [error, setError] = useState<string | null>(null)
  const [nextAfter, setNextAfter] = useState(() => initialCursor(initialJob))
  const jobRef = useRef<ContentJob | null>(initialJob ?? null)
  const cursorRef = useRef(initialCursor(initialJob))
  const setJob = useCallback((nextJob: ContentJob | null) => {
    jobRef.current = nextJob
    setJobState(nextJob)
  }, [])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const nextJob = await getJob(jobId)
      let cursor = cursorRef.current
      try {
        const eventPage = await getJobEvents(jobId, cursor)
        cursor = eventPage.next_after
        cursorRef.current = cursor
      } catch {
        // The Job projection is still authoritative when the incremental event read is unavailable.
      }
      setJob(nextJob)
      setNextAfter(cursor)
      setLoading(false)
      return nextJob
    } catch (caught) {
      setError(errorMessage(caught))
      setLoading(false)
      return null
    }
  }, [jobId, setJob])

  useEffect(() => {
    let disposed = false
    let firstLoad = true

    const poll = async () => {
      if (disposed) return
      if (!firstLoad && jobRef.current && terminalStatuses.has(jobRef.current.status)) {
        window.clearInterval(timer)
        return
      }
      firstLoad = false
      const nextJob = await refresh()
      if (disposed || !nextJob || !terminalStatuses.has(nextJob.status)) return
      window.clearInterval(timer)
    }

    const timer = window.setInterval(() => void poll(), 2_000)
    void poll()
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [refresh])

  return {
    job,
    setJob,
    loading,
    error,
    nextAfter,
    refresh,
    isActive: job ? activeStatuses.has(job.status) : false,
  }
}
