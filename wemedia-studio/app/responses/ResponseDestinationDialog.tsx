'use client'

import { useState, type FormEvent } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ResponseDetail } from '@/lib/api/responses'

export type DestinationKind = 'creative_asset'

export function ResponseDestinationDialog({
  open,
  destination,
  detail,
  directories,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  destination: DestinationKind | null
  detail: ResponseDetail | null
  directories: string[]
  busy: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: (value: { destination: DestinationKind; analysis_run_id: number; directory: string | null }) => void
}) {
  const [directory, setDirectory] = useState('')
  if (!destination || !detail?.analysis) return null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (detail.current_analysis_run_id === null) return
    onConfirm({
      destination,
      analysis_run_id: detail.current_analysis_run_id,
      directory: directory || null,
    })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>保存为创作资产</DialogTitle>
          <DialogDescription>会同时保存完整原文快照和 AI 评价快照，方便后续创作复用。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs text-muted-foreground">建议标题</p>
            <p className="mt-1 font-medium">{detail.analysis.suggested_title}</p>
            <p className="mt-3 text-xs text-muted-foreground">建议角度</p>
            <p className="mt-1 text-sm leading-6">{detail.analysis.suggested_angle}</p>
          </div>
          <label className="block text-sm">
            <span className="mb-2 block font-medium">文章资产目录（可选）</span>
            <select value={directory} onChange={event => setDirectory(event.target.value)} className="h-10 w-full rounded-lg border border-input bg-background px-3">
              <option value="">不指定目录</option>
              {directories.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
            <Button type="submit" disabled={busy || detail.current_analysis_run_id === null}>
              {busy ? '保存中…' : '保存创作资产'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
