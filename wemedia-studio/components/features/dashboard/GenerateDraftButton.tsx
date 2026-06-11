'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PenLine, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api/client'

export function GenerateDraftButton({ repoId, tag }: { repoId: string; tag: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    try {
      // repoId 形如 "owner/repo"，正好占 path 两段
      const res = await apiFetch<{ drafts_created: number }>(
        `/github/releases/${repoId}/${encodeURIComponent(tag)}/generate-draft`,
        { method: 'POST' },
      )
      toast.success(`已生成 ${res.drafts_created} 篇草稿`)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handle}
      disabled={loading}
      className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 shrink-0"
    >
      {loading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />}
      {loading ? '生成中…' : '生成草稿'}
    </button>
  )
}
