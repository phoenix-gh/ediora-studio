'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { triggerFullAnalysis } from '@/lib/api/write'
import { toast } from 'sonner'

export function GenerateButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    try {
      const res = await triggerFullAnalysis()
      if (res.new_topics > 0) {
        toast.success(`AI 分析完成：新增选题 ${res.new_topics} 个`)
        router.refresh()
      } else {
        toast('分析完成，暂无新内容（订阅账号可能尚未采集到数据）')
      }
    } catch {
      toast.error('生成失败，请检查 ANTHROPIC_API_KEY 是否已配置')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button size="sm" onClick={handle} disabled={loading} className="gap-1.5">
      {loading
        ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        : <Sparkles className="w-3.5 h-3.5" />}
      {loading ? 'AI 分析中…' : 'AI 一键生成'}
    </Button>
  )
}
